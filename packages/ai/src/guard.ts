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
 * What the rollup actually knows about this month: a figure, and how much of the bill it
 * could not see.
 *
 * `ai_generations.cost_usd` is nullable and means "the provider reported no usage for
 * this attempt", which is emphatically not $0.00. The `ai_daily_cost` view used to
 * `coalesce(sum(cost_usd), 0)` and hand the guard a number that could not be told apart
 * from a quiet month. That is the failure mode a budget guard exists to prevent, arriving
 * through the guard's own input.
 *
 * So spend is a **lower bound plus a count of unknowns**, and both travel together. There
 * is deliberately no way to construct this from a bare number: a caller that only has a
 * sum has to write `unpricedCalls: 0` and thereby state that it checked.
 */
export interface SpendReading {
  /** Month-to-date USD from the rollup. A LOWER BOUND when `unpricedCalls > 0`. */
  readonly costUsd: number;
  /** Attempts this month whose cost could not be determined. Real spend, unknown amount. */
  readonly unpricedCalls: number;
}

/**
 * How many unpriced attempts in a month are written off as noise before the guard stops
 * trusting its own figure.
 *
 * **The decision, stated plainly:** an unpriced call is NOT charged a made-up price. There
 * is no defensible number — the attempt reported no usage, so any figure would be
 * invented, and `pricing.ts` already refuses to invent rates it was not given. Instead the
 * *count* is treated as a signal about the figure's reliability, and past the tolerance the
 * posture is stepped up one level: the guard behaves as if spend had crossed the next
 * threshold, because for all it knows it has.
 *
 * **Why step the posture instead of halting.** §6's ordering principle is that interactive
 * chat is the last thing to die and background regeneration the first. A metering outage is
 * a reason to stop doing optional work; it is not a reason to break the thing the user is
 * looking at. Stepping the posture cuts background jobs — deep first, then balanced —
 * and leaves interactive calls alone at every level, exactly as a genuine overspend would.
 * Halting on a metering blip would be the guard inflicting a worse outage than the one it
 * is reacting to.
 *
 * **Why 5.** The §2 ladder burns up to three attempts on a single logical call, so one
 * thoroughly unlucky call can produce three unpriced rows without anything being
 * systematically wrong. Five leaves room for that plus a straggler. A sixth in the same
 * month is not bad luck — it means metering is broken, and a month-to-date figure from
 * broken metering should not be the thing authorising more spend.
 */
export const UNPRICED_TOLERANCE = 5;

/**
 * One step up the posture ladder, capped below `halt`.
 *
 * `defer-balanced` does NOT escalate to `halt`. Halting is indistinguishable from the kill
 * switch and takes interactive chat down with it, and a metering failure must never be
 * able to do that on its own — only real, *observed* spend crossing 150% may. Unknown
 * spend can defer background work to its strictest setting and stops there. An already
 * halted month stays halted, because the escalation never lowers a posture.
 */
function escalatePosture(posture: SpendPosture): SpendPosture {
  switch (posture) {
    case "normal":
      return "defer-deep";
    case "defer-deep":
    case "defer-balanced":
      return "defer-balanced";
    case "halt":
      return "halt";
  }
}

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
  /**
   * Attempts this month the rollup could not price. Optional so the pure
   * budget-ratio behaviour stays directly testable; every real caller passes it, and
   * `AISpendGuardConfig.monthToDateSpend` makes it structurally impossible to omit.
   */
  readonly unpricedCalls?: number;
}): SpendPosture {
  if (!Number.isFinite(input.monthlyBudgetUsd) || input.monthlyBudgetUsd <= 0) return "halt";
  // A non-finite spend figure means the rollup read failed to produce a number. Treat it
  // as unknown-but-safe: `normal`, because halting all AI on a transient read failure is
  // a worse outcome than one uncapped call, and the read is retried on the next call.
  if (!Number.isFinite(input.monthToDateUsd)) return "normal";

  const ratio = Math.max(input.monthToDateUsd, 0) / input.monthlyBudgetUsd;
  const observed: SpendPosture =
    ratio >= SPEND_THRESHOLDS.halt
      ? "halt"
      : ratio >= SPEND_THRESHOLDS.deferBalanced
        ? "defer-balanced"
        : ratio >= SPEND_THRESHOLDS.deferDeep
          ? "defer-deep"
          : "normal";

  // Past the tolerance, `monthToDateUsd` is known to understate the month by an unknown
  // amount, so the posture it implies is a floor rather than an answer. See
  // `UNPRICED_TOLERANCE` for why this steps rather than halts, and why it invents no price.
  const unpriced = input.unpricedCalls ?? 0;
  return Number.isFinite(unpriced) && unpriced > UNPRICED_TOLERANCE
    ? escalatePosture(observed)
    : observed;
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
   * Month-to-date spend from the §6 rollup, for the user this runtime belongs to.
   *
   * Injected rather than queried here: this package does no I/O. Implementations should
   * cache briefly — it is consulted once per `generateStructured` call, and a rollup read
   * per call would be a database round trip in front of every LLM request.
   *
   * Returns a `SpendReading`, not a number, and that is the whole point of the type: the
   * previous `() => number` signature made it impossible for a reader to *report* that
   * part of the bill was unknown, so `ai_daily_cost`'s `coalesce(sum(cost_usd), 0)` sailed
   * straight through as fact. Widening the return means every reader now has to say
   * whether it looked.
   */
  readonly monthToDateSpend: () => SpendReading | Promise<SpendReading>;
}
