/**
 * The kill switch and the budget guard (PLAN.md §AI Strategy §6).
 *
 * Pure decision logic: given "is the switch flipped", "how much has been spent this
 * month", "what rank is this job" and "is a human waiting for it", decide whether the
 * call may proceed. No I/O, no `process.env`, no clock — the month-to-date figure is
 * injected by whoever owns the database, which is what keeps this unit-testable and
 * keeps `packages/ai` runnable anywhere.
 *
 * The ordering principle §6 states, and the one thing to preserve if this is ever
 * changed: **interactive chat is the last thing to die, background regeneration the
 * first.** Every threshold below cuts background work before it touches a user who is
 * sitting there waiting.
 */

import type { JobId, Rank } from "./models";
import { RANK } from "./models";

/**
 * How constrained spending currently is. Ordered from cheapest to most severe; the
 * thresholds are §6's, expressed as fractions of `AI_MONTHLY_BUDGET_USD`.
 */
export type SpendPosture =
  /** Under budget. Everything runs. */
  | "normal"
  /** ≥100%: deep-rank background jobs (Opus, Gemini Pro) are deferred. */
  | "defer-deep"
  /** ≥125%: balanced-rank background jobs are deferred too. */
  | "defer-balanced"
  /** ≥150% (≈ §4's $110 hard threshold): behave exactly as if AI_KILL_SWITCH were set. */
  | "halt";

/** §6's thresholds as fractions of the monthly budget. */
export const SPEND_THRESHOLDS = {
  deferDeep: 1.0,
  deferBalanced: 1.25,
  halt: 1.5,
} as const;

/**
 * Whether a human is waiting on this call.
 *
 * The default at every call site is `background`, deliberately: a job that forgot to
 * declare itself gets the *stricter* treatment, so the failure mode of forgetting is a
 * deferred background job rather than an unbounded bill.
 */
export type CallKind = "interactive" | "background";

export type PausedReason =
  /** `AI_KILL_SWITCH=true`. The runaway-cost circuit breaker. */
  | "kill-switch"
  /** Spend ≥150% of budget — §6 says treat this as the kill switch. */
  | "budget-halt"
  /** Spend ≥100%: this is a deep-rank background job. */
  | "budget-defer-deep"
  /** Spend ≥125%: this is a balanced-or-deeper background job. */
  | "budget-defer-balanced";

/**
 * Thrown instead of making the call. **Never** a data error — the work was not attempted,
 * so nothing failed and nothing is lost.
 *
 * An Inngest step must let this propagate as a *retryable* error so the job stays queued
 * and runs when the switch flips back or the month rolls over (§6: "jobs remain queued,
 * nothing is lost"). Converting it to `NonRetriableError` would throw away exactly the
 * work the guard is trying to preserve.
 */
export class AIPausedError extends Error {
  readonly reason: PausedReason;
  readonly job: JobId | undefined;

  constructor(reason: PausedReason, options?: { job?: JobId }) {
    super(pausedMessage(reason));
    this.name = "AIPausedError";
    this.reason = reason;
    this.job = options?.job;
  }

  /** True for every reason: the call never ran, so retrying later is always correct. */
  get retryable(): boolean {
    return true;
  }
}

/**
 * The user-facing line §6 asks for. Chat shows this rather than an error — being paused
 * is a deliberate state, not a fault.
 */
export const AI_PAUSED_USER_MESSAGE = "AI features are paused.";

function pausedMessage(reason: PausedReason): string {
  switch (reason) {
    case "kill-switch":
      return `${AI_PAUSED_USER_MESSAGE} AI_KILL_SWITCH is set — no LLM call will be made.`;
    case "budget-halt":
      return `${AI_PAUSED_USER_MESSAGE} Month-to-date spend is at or above 150% of AI_MONTHLY_BUDGET_USD, which §6 treats as the kill switch.`;
    case "budget-defer-deep":
      return "Deferred: month-to-date spend is at or above AI_MONTHLY_BUDGET_USD, so deep-rank background jobs are paused. Interactive calls still run.";
    case "budget-defer-balanced":
      return "Deferred: month-to-date spend is at or above 125% of AI_MONTHLY_BUDGET_USD, so balanced-rank and deeper background jobs are paused. Interactive calls still run.";
  }
}

/**
 * Month-to-date spend against the budget → a posture.
 *
 * A budget of zero or less means "spend nothing", which is `halt` rather than a division
 * by zero. Negative spend is impossible from the rollup (`cost_usd >= 0` is a check
 * constraint) but is clamped rather than trusted, because this function is also fed by
 * whatever a future caller passes in.
 */
export function spendPosture(input: {
  readonly monthToDateUsd: number;
  readonly monthlyBudgetUsd: number;
}): SpendPosture {
  if (!Number.isFinite(input.monthlyBudgetUsd) || input.monthlyBudgetUsd <= 0) return "halt";
  // A non-finite spend figure means the rollup read failed to produce a number. Treat it
  // as unknown-but-safe: `normal`, because halting all AI on a transient read failure is
  // a worse outcome than one uncapped call, and the read is retried on the next call.
  if (!Number.isFinite(input.monthToDateUsd)) return "normal";

  const ratio = Math.max(input.monthToDateUsd, 0) / input.monthlyBudgetUsd;
  if (ratio >= SPEND_THRESHOLDS.halt) return "halt";
  if (ratio >= SPEND_THRESHOLDS.deferBalanced) return "defer-balanced";
  if (ratio >= SPEND_THRESHOLDS.deferDeep) return "defer-deep";
  return "normal";
}

export type GuardDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: PausedReason };

const ALLOWED: GuardDecision = { allowed: true };

/**
 * The whole §6 policy in one place.
 *
 * Order matters and encodes the priority: the kill switch beats everything, a halt is
 * indistinguishable from the kill switch, and only *after* those does "is a human
 * waiting?" get asked — which is what makes interactive chat the last thing to die.
 */
export function guardDecision(input: {
  readonly killSwitch: boolean;
  readonly posture: SpendPosture;
  readonly rank: Rank;
  readonly kind: CallKind;
}): GuardDecision {
  if (input.killSwitch) return { allowed: false, reason: "kill-switch" };
  if (input.posture === "halt") return { allowed: false, reason: "budget-halt" };

  // Everything below this line is a soft cap on *background* work only.
  if (input.kind === "interactive") return ALLOWED;

  if (input.posture === "defer-balanced" && RANK[input.rank] >= RANK.balanced) {
    return { allowed: false, reason: "budget-defer-balanced" };
  }
  if (input.posture === "defer-deep" && RANK[input.rank] >= RANK.deep) {
    return { allowed: false, reason: "budget-defer-deep" };
  }
  return ALLOWED;
}

/**
 * What the app injects so `packages/ai` can enforce §6 without reading `process.env`.
 *
 * `apps/web/src/env.ts` supplies `killSwitch` (`AI_KILL_SWITCH`) and `monthlyBudgetUsd`
 * (`AI_MONTHLY_BUDGET_USD`); `monthToDateSpendUsd` reads the `ai_daily_cost` rollup.
 * `AI_MAX_TIER` is the third §6 var and lives separately, as `AIRuntimeConfig.maxRank`,
 * because it clamps model *resolution* rather than gating the call.
 */
export interface AISpendGuardConfig {
  /** `AI_KILL_SWITCH`. Checked first, before anything else can cost money. */
  readonly killSwitch: boolean;
  /** `AI_MONTHLY_BUDGET_USD` (default 75). */
  readonly monthlyBudgetUsd: number;
  /**
   * Month-to-date spend in USD from the §6 rollup, for the user this runtime belongs to.
   *
   * Injected rather than queried here: this package does no I/O. Implementations should
   * cache briefly — it is consulted once per `generateStructured` call, and a rollup read
   * per call would be a database round trip in front of every LLM request.
   */
  readonly monthToDateSpendUsd: () => number | Promise<number>;
}
