/**
 * The structured-output failure ladder (PLAN.md §AI Strategy §2).
 *
 * Exactly three rungs, and **never a loop**:
 *  1. `generateObject` throws `NoObjectGeneratedError` → **one corrective retry** on the
 *     same model, with the validation error appended to the prompt. This fixes the large
 *     majority of failures.
 *  2. Still failing → **one rank escalation**, deliberately **cross-provider where the job
 *     allows** (`gemini-3.1-flash-lite` → `claude-sonnet-5`). A schema failure on one model
 *     family often clears on another; a failure *both* families reject is almost always a
 *     schema bug, not model flakiness, and no amount of retrying will fix it.
 *  3. **Dead-letter**: mark failed, hand back the raw `.text` and the error so the caller
 *     can persist them for debugging and surface a regenerate affordance.
 *
 * **Refusals are logged, never retried identically.** A refusal is the model declining, not
 * failing — re-sending the same prompt just buys another refusal. It exits the ladder
 * immediately, at whatever rung it occurs.
 *
 * Transport errors (429/500/529/network) are NOT this module's business: they propagate so
 * the Inngest step retry policy (§6) owns backoff in one visible, bounded place. This ladder
 * handles one thing — output that doesn't satisfy the schema.
 *
 * The control flow is separated from the SDK call on purpose: `attempt` is injected, so the
 * ladder is exhaustively unit-testable with no network, no keys and no timing.
 */

import { escalationTarget, type ModelId, type Rank } from "./models";
import type { TokenUsage } from "./pricing";

export type LadderStep = "initial" | "corrective-retry" | "escalation";

export interface AttemptRequest {
  readonly model: ModelId;
  readonly step: LadderStep;
  /** 1-based. Structurally bounded at 3. */
  readonly attempt: number;
  /** Validation feedback to append to the prompt. Present only on `corrective-retry`. */
  readonly corrective?: string;
}

export type AttemptResult<T> =
  | { readonly status: "success"; readonly value: T; readonly usage?: TokenUsage }
  | {
      readonly status: "schema-failure";
      readonly message: string;
      readonly rawText?: string;
      readonly usage?: TokenUsage;
    }
  | {
      readonly status: "refusal";
      readonly message: string;
      readonly rawText?: string;
      readonly usage?: TokenUsage;
    };

/** One rung, as it happened. Carried into the result so every attempt can be logged. */
export interface AttemptRecord {
  readonly model: ModelId;
  readonly step: LadderStep;
  readonly attempt: number;
  readonly outcome: AttemptResult<unknown>["status"];
  readonly message?: string;
  readonly rawText?: string;
  readonly usage?: TokenUsage;
  readonly latencyMs: number;
}

export type DeadLetterReason =
  /** Both the corrective retry and the escalation returned invalid output. Suspect the schema. */
  | "schema"
  /** The model declined. Never retried identically. */
  | "refusal"
  /** Nowhere to escalate: already top-rank, or the AI_MAX_TIER clamp forbade the step. */
  | "no-escalation-target";

export type LadderResult<T> =
  | {
      readonly status: "success";
      readonly value: T;
      readonly model: ModelId;
      readonly attempts: readonly AttemptRecord[];
    }
  | {
      readonly status: "dead-letter";
      readonly reason: DeadLetterReason;
      readonly message: string;
      /** The last raw model output, for debugging. Persist it — it is the only evidence. */
      readonly rawText?: string;
      readonly attempts: readonly AttemptRecord[];
    };

export interface LadderOptions<T> {
  readonly startModel: ModelId;
  /** Performs one attempt. Injected so the ladder is testable without a provider. */
  readonly attempt: (request: AttemptRequest) => Promise<AttemptResult<T>>;
  /** The `AI_MAX_TIER` clamp (§6). Constrains escalation; may remove it entirely. */
  readonly maxRank?: Rank;
  /** Wall clock, injectable for deterministic tests. */
  readonly now?: () => number;
}

/** §2's corrective-retry wording. Appended to the prompt on rung 2. */
export function correctiveMessage(validationError: string): string {
  return `Your previous output failed validation: ${validationError}\nReturn only corrected JSON that satisfies the schema. Do not explain the error.`;
}

/**
 * Runs the ladder. Resolves to a success or a dead-letter — it does not throw for schema
 * failures, because a dead-letter is an outcome the caller must handle (persist + offer
 * regenerate), not an exception to swallow.
 */
export async function runStructuredLadder<T>(options: LadderOptions<T>): Promise<LadderResult<T>> {
  const now = options.now ?? (() => Date.now());
  const attempts: AttemptRecord[] = [];

  const run = async (request: AttemptRequest): Promise<AttemptResult<T>> => {
    const startedAt = now();
    const result = await options.attempt(request);
    attempts.push({
      model: request.model,
      step: request.step,
      attempt: request.attempt,
      outcome: result.status,
      message: result.status === "success" ? undefined : result.message,
      rawText: result.status === "success" ? undefined : result.rawText,
      usage: result.usage,
      latencyMs: now() - startedAt,
    });
    return result;
  };

  // Rung 1 — the initial call.
  const first = await run({ model: options.startModel, step: "initial", attempt: 1 });
  if (first.status === "success") {
    return { status: "success", value: first.value, model: options.startModel, attempts };
  }
  if (first.status === "refusal") {
    return {
      status: "dead-letter",
      reason: "refusal",
      message: first.message,
      rawText: first.rawText,
      attempts,
    };
  }

  // Rung 2 — one corrective retry on the same model, with the validation error appended.
  const second = await run({
    model: options.startModel,
    step: "corrective-retry",
    attempt: 2,
    corrective: correctiveMessage(first.message),
  });
  if (second.status === "success") {
    return { status: "success", value: second.value, model: options.startModel, attempts };
  }
  if (second.status === "refusal") {
    return {
      status: "dead-letter",
      reason: "refusal",
      message: second.message,
      rawText: second.rawText,
      attempts,
    };
  }

  // Rung 3 — one rank escalation, cross-provider where the job allows.
  const escalated = escalationTarget(options.startModel, { maxRank: options.maxRank });
  if (escalated === undefined) {
    return {
      status: "dead-letter",
      reason: "no-escalation-target",
      message: `No escalation target above "${options.startModel}"${
        options.maxRank === undefined ? "" : ` within the AI_MAX_TIER clamp "${options.maxRank}"`
      }: ${second.message}`,
      rawText: second.rawText,
      attempts,
    };
  }

  const third = await run({
    model: escalated,
    step: "escalation",
    attempt: 3,
    corrective: correctiveMessage(second.message),
  });
  if (third.status === "success") {
    return { status: "success", value: third.value, model: escalated, attempts };
  }

  // Rung 4 does not exist. Both families rejected it — that is a schema bug, so stop.
  return {
    status: "dead-letter",
    reason: third.status === "refusal" ? "refusal" : "schema",
    message: third.message,
    rawText: third.rawText,
    attempts,
  };
}
