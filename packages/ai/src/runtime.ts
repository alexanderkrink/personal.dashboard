/**
 * The AI runtime: the single call wrapper every LLM call goes through.
 *
 * This is where the four concerns from §AI Strategy meet:
 * - **job → model resolution** (§1): callers name a job, never a model.
 * - **the §3 stamp**: `prompt_id`, `prompt_version`, `provider`, `model`, `input_hash` are
 *   assembled *here*, from data the wrapper already has. A caller cannot forget to stamp
 *   because a caller never gets the chance to write one.
 * - **the §2 failure ladder**: corrective retry → cross-provider escalation → dead-letter.
 * - **metering** (§5/§6): every attempt — success, retry, escalation, dead-letter — is
 *   handed to `log` with the full stamp, token usage and latency attached, as it completes.
 *
 * ## Metering is structural, not optional
 *
 * `AIRuntimeConfig.log` and `AIRuntimeConfig.guard` are **required**. There is no way to
 * construct a runtime that can spend money without a metering sink and a kill switch —
 * that is a compile error, not a review comment. `log` is called once per ladder attempt
 * from `emit()` below with an already-complete `AIGenerationRecord`, so a caller cannot
 * forget to stamp because a caller never gets the chance to write one.
 *
 * ⚠ TWO PATHS CAN STILL MAKE AN LLM CALL WITHOUT LANDING A ROW, and the M1 DoD ("every AI
 * call appears in `ai_generations` with cost") is not satisfied until both close:
 *  1. `unmeteredLanguageModel()` and `unmeteredProviders()` hand out a raw AI SDK model.
 *     Anything built on them — `streamText` for chat/RAG and lesson prose (§2) — bypasses
 *     `emit()` entirely. They are named for what they are and require an explicit
 *     acknowledgement argument, so reaching one is a decision rather than an accident, but
 *     the real fix is a metered streaming wrapper (stamp + `onFinish` usage) and it has to
 *     land *with* chat/RAG in Wave 4, not after it.
 *  2. An attempt that dies with a *transport* error is never a completed attempt, so it
 *     produces no record here. §6 wants that error persisted; that belongs in the Inngest
 *     step wrapper, which is where the `NonRetriableError` decision already lives — and
 *     `ai_generations.outcome` already accepts `'transport-error'` so closing it is a code
 *     change, not a migration. Earlier completed rungs ARE metered before it throws.
 *
 * This package never reads `process.env`. `apps/web/src/env.ts` injects both provider keys,
 * the clamp, the guard and the logger.
 */

import { generateObject, NoObjectGeneratedError } from "ai";
import type { z } from "zod";
import {
  AIPausedError,
  type AISpendGuardConfig,
  type CallKind,
  type GuardDecision,
  guardDecision,
  spendPosture,
} from "./guard";
import {
  type AttemptRecord,
  type AttemptResult,
  type LadderResult,
  runStructuredLadder,
} from "./ladder";
import {
  getModel,
  type JobId,
  MODELS,
  type ModelId,
  type ModelResolution,
  type ProviderName,
  type Rank,
} from "./models";
import type { TokenUsage } from "./pricing";
import { jobForPromptId, type PromptTemplate, type PromptVars } from "./prompts/define";
import { type AIProviders, createAIProvider, languageModelFor } from "./provider";

/**
 * The §3 five-column stamp. Every persisted AI artifact carries these, and so does every
 * `ai_generations` row.
 *
 * `provider` and `model` are the **concrete** pair that actually ran — not the pair the job
 * is pinned to today. A job can be re-pointed, and an escalated attempt runs on a different
 * model than the one it started on, so the stamp records what happened rather than what was
 * configured. That is also what lets the §6 rollup price each call against its own
 * provider's table.
 */
export interface AIGenerationStamp {
  readonly promptId: string;
  readonly promptVersion: number;
  readonly job: JobId;
  readonly provider: ProviderName;
  readonly model: ModelId;
  /** SHA-256 of the rendered prompt. Drives the §5 idempotency short-circuit. */
  readonly inputHash: string;
}

/** One `ai_generations` row: the stamp plus what the attempt cost and how it ended. */
export interface AIGenerationRecord extends AIGenerationStamp {
  readonly step: AttemptRecord["step"];
  readonly attempt: number;
  readonly outcome: AttemptRecord["outcome"];
  readonly usage?: TokenUsage;
  readonly latencyMs: number;
  /** Raw model output on failure. The only debugging evidence a dead-letter leaves behind. */
  readonly rawText?: string;
  readonly errorMessage?: string;
}

/**
 * Writes one `ai_generations` row. Implemented in `apps/web/src/lib/ai/generations.ts`.
 *
 * Awaited, so a logging failure surfaces rather than vanishing into an unhandled rejection —
 * an unmetered call is a hole in the budget guard, not a cosmetic problem.
 */
export type AIGenerationLogger = (record: AIGenerationRecord) => void | Promise<void>;

export interface AIRuntimeConfig {
  readonly anthropicApiKey: string;
  readonly googleApiKey: string;
  /**
   * The `ai_generations` writer. **Required** — there is deliberately no way to build a
   * runtime that can spend money without a metering sink. A test that genuinely does not
   * care still has to write `log: () => {}`, which is three characters of friction and a
   * grep-able marker; forgetting it is a type error rather than a silent gap in the DoD.
   */
  readonly log: AIGenerationLogger;
  /**
   * The §6 kill switch and budget guard. **Required** for the same reason as `log`: a
   * runtime with no circuit breaker is exactly the thing §6 exists to make impossible.
   */
  readonly guard: AISpendGuardConfig;
  /** `AI_MAX_TIER` (§6): clamps resolved rank and constrains ladder escalation. */
  readonly maxRank?: Rank;
}

export interface GenerateStructuredOptions<TVars extends PromptVars, TSchema extends z.ZodType> {
  readonly prompt: PromptTemplate<TVars>;
  readonly vars: TVars;
  readonly schema: TSchema;
  readonly system?: string;
  /** Overrides the job derived from `prompt.id`. Needed only by variant-suffixed prompts. */
  readonly job?: JobId;
  /**
   * Whether a human is waiting (§6). Defaults to `"background"` — the stricter side — so a
   * call site that forgets to declare itself gets deferred under budget pressure rather
   * than running up the bill.
   */
  readonly kind?: CallKind;
}

export type GenerateStructuredResult<T> =
  | { readonly status: "success"; readonly value: T; readonly stamp: AIGenerationStamp }
  | {
      readonly status: "dead-letter";
      readonly reason: Extract<LadderResult<never>, { status: "dead-letter" }>["reason"];
      readonly message: string;
      readonly rawText?: string;
      readonly stamp: AIGenerationStamp;
    };

/**
 * The literal a caller must type to reach an unmetered model. It is not a password — it is
 * a speed bump in the type system.
 *
 * The point is that no plausible refactor, autocomplete or copy-paste produces this string
 * by accident, and `grep -r UNMETERED_ACKNOWLEDGEMENT` enumerates every remaining hole in
 * the M1 DoD in one command. Wave 4 deletes both escape hatches when the metered streaming
 * wrapper lands; until then this is what keeps "it bypasses `ai_generations`" a stated
 * decision rather than an accident.
 */
export const UNMETERED_ACKNOWLEDGEMENT = "i-will-meter-this-call-myself" as const;
export type UnmeteredAcknowledgement = typeof UNMETERED_ACKNOWLEDGEMENT;

export interface AIRuntime {
  /** Job → `(provider, model)`, with the `AI_MAX_TIER` clamp applied. Pure; spends nothing. */
  resolve(job: JobId): ModelResolution;
  /** Job → structured output through the §2 failure ladder, fully stamped and metered. */
  generateStructured<TVars extends PromptVars, TSchema extends z.ZodType>(
    options: GenerateStructuredOptions<TVars, TSchema>,
  ): Promise<GenerateStructuredResult<z.infer<TSchema>>>;
  /**
   * ⚠ A raw AI SDK model. **Nothing built on this reaches `ai_generations`** — no stamp,
   * no usage, no cost, invisible to the budget guard. It exists only because `streamText`
   * (chat/RAG, lesson prose) has no metered wrapper yet.
   *
   * The kill switch and budget guard are NOT applied here either, because there is no call
   * for them to gate — the caller makes the call. A caller reaching for this owes both:
   * check `guardCheck()` before streaming, and write the row from `onFinish`.
   */
  unmeteredLanguageModel(
    job: JobId,
    acknowledgement: UnmeteredAcknowledgement,
  ): ReturnType<typeof languageModelFor>;
  /** ⚠ Both raw providers. Same warning as `unmeteredLanguageModel`. */
  unmeteredProviders(acknowledgement: UnmeteredAcknowledgement): AIProviders;
  /**
   * The §6 guard decision on its own, without making a call.
   *
   * For the two callers that cannot go through `generateStructured`: a chat route that
   * must render "AI features are paused" instead of streaming, and any future metered
   * streaming wrapper. Returns rather than throws, because a chat endpoint wants to answer
   * politely rather than 500.
   */
  guardCheck(job: JobId, kind?: CallKind): Promise<GuardDecision>;
}

/** SHA-256 hex via Web Crypto — available in node 18+, edge and the browser alike. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** AI SDK usage → the shape the price tables expect. `input` excludes cached tokens. */
function toTokenUsage(usage: {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  inputTokenDetails?:
    | {
        noCacheTokens?: number | undefined;
        cacheReadTokens?: number | undefined;
        cacheWriteTokens?: number | undefined;
      }
    | undefined;
}): TokenUsage {
  const details = usage.inputTokenDetails;
  const cacheRead = details?.cacheReadTokens ?? 0;
  const cacheWrite = details?.cacheWriteTokens ?? 0;
  // Prefer the explicitly non-cached count; `inputTokens` includes cached tokens on some
  // providers, and billing those at the full input rate would overstate every cached call.
  const input = details?.noCacheTokens ?? Math.max((usage.inputTokens ?? 0) - cacheRead, 0);
  return { input, output: usage.outputTokens ?? 0, cacheRead, cacheWrite };
}

/**
 * A refusal is the model declining, not failing (§2). It must never be retried identically,
 * so it has to be distinguishable from a malformed-output failure before the ladder decides.
 *
 * ⚠ Built, and unit-tested against synthetic errors — but never observed against a live
 * refusal. Study content should essentially never trip this, which is exactly why the
 * detection cannot be confirmed empirically here.
 */
function isRefusal(error: unknown): boolean {
  if (!NoObjectGeneratedError.isInstance(error)) return false;
  return error.finishReason === "content-filter";
}

export function createAIRuntime(config: AIRuntimeConfig): AIRuntime {
  const providers = createAIProvider({
    anthropicApiKey: config.anthropicApiKey,
    googleApiKey: config.googleApiKey,
  });

  const resolve = (job: JobId): ModelResolution => getModel(job, { maxRank: config.maxRank });

  /**
   * §6, in the one place every metered call passes through.
   *
   * The kill switch is checked **first**, synchronously, before the rollup is read and
   * before a job is even resolved — flipping one env var must not still cost a database
   * round trip, and it must not depend on any query succeeding.
   */
  const decide = async (job: JobId, kind: CallKind): Promise<GuardDecision> => {
    if (config.guard.killSwitch) return { allowed: false, reason: "kill-switch" };
    const monthToDateUsd = await config.guard.monthToDateSpendUsd();
    return guardDecision({
      killSwitch: false,
      posture: spendPosture({
        monthToDateUsd,
        monthlyBudgetUsd: config.guard.monthlyBudgetUsd,
      }),
      // The clamped rank, not the pinned one: if AI_MAX_TIER already forced a deep job
      // down to `fast`, deferring it as though it were still deep would be wrong.
      rank: resolve(job).rank,
      kind,
    });
  };

  return {
    resolve,
    guardCheck: (job, kind) => decide(job, kind ?? "background"),
    unmeteredLanguageModel: (job, _acknowledgement) =>
      languageModelFor(providers, resolve(job).model),
    unmeteredProviders: (_acknowledgement) => providers,

    async generateStructured<TVars extends PromptVars, TSchema extends z.ZodType>({
      prompt,
      vars,
      schema,
      system,
      job: jobOverride,
      kind,
    }: GenerateStructuredOptions<TVars, TSchema>): Promise<
      GenerateStructuredResult<z.infer<TSchema>>
    > {
      // ── AI_KILL_SWITCH (§6) ──────────────────────────────────────────────────────
      // Absolutely first: before a job is resolved, before the prompt is rendered, before
      // the rollup is read, before any token is spent. Failing fast at this line is what
      // makes "flip one Vercel env var + redeploy" stop all spend within minutes.
      if (config.guard.killSwitch) throw new AIPausedError("kill-switch");

      const job = jobOverride ?? jobForPromptId(prompt.id);
      if (job === undefined) {
        throw new Error(
          `Prompt id "${prompt.id}" does not resolve to a job. Per §3 a prompt id must equal the key of the job that runs it.`,
        );
      }

      // ── AI_MONTHLY_BUDGET_USD (§6) ───────────────────────────────────────────────
      // Also before any token is spent. Job resolution above is pure and free, and the
      // guard needs the resolved rank to know whether this job is one of the ones deferred
      // at 100% / 125%.
      const decision = await decide(job, kind ?? "background");
      if (!decision.allowed) throw new AIPausedError(decision.reason, { job });

      const rendered = prompt.render(vars);
      const inputHash = await sha256Hex(`${prompt.id}@${prompt.version}\n${rendered}`);
      const start = resolve(job);

      const emit = async (record: AttemptRecord): Promise<void> => {
        await config.log({
          promptId: prompt.id,
          promptVersion: prompt.version,
          job,
          // The concrete model that ran this attempt, which after an escalation is not
          // the model the job is pinned to.
          model: record.model,
          provider: MODELS[record.model].provider,
          inputHash,
          step: record.step,
          attempt: record.attempt,
          outcome: record.outcome,
          usage: record.usage,
          latencyMs: record.latencyMs,
          rawText: record.rawText,
          errorMessage: record.message,
        });
      };

      const result = await runStructuredLadder<z.infer<TSchema>>({
        startModel: start.model,
        maxRank: config.maxRank,
        // Metering is structural AND eager: each attempt is logged the moment it completes,
        // not after the ladder returns. A transport error on a later rung propagates (below),
        // so batching the emits at the end would silently discard every earlier rung — paid
        // attempts that never reach `ai_generations`. Rows land in attempt order.
        onAttempt: emit,
        attempt: async (request): Promise<AttemptResult<z.infer<TSchema>>> => {
          const promptText =
            request.corrective === undefined ? rendered : `${rendered}\n\n${request.corrective}`;
          try {
            const generated = await generateObject({
              model: languageModelFor(providers, request.model),
              schema,
              prompt: promptText,
              ...(system === undefined ? {} : { system }),
            });
            return {
              status: "success",
              // `generateObject` cannot narrow its return through a still-generic `TSchema`,
              // so the cast restates what Zod has already checked at runtime: the object
              // parsed against `schema`, or `NoObjectGeneratedError` would have been thrown.
              value: generated.object as z.infer<TSchema>,
              usage: toTokenUsage(generated.usage),
            };
          } catch (error) {
            if (!NoObjectGeneratedError.isInstance(error)) {
              // Transport/rate-limit/auth errors are not the ladder's business — they
              // propagate so the Inngest step retry policy (§6) owns backoff.
              throw error;
            }
            const base = {
              message: error.message,
              rawText: error.text,
              usage: error.usage === undefined ? undefined : toTokenUsage(error.usage),
            };
            return isRefusal(error)
              ? { status: "refusal", ...base }
              : { status: "schema-failure", ...base };
          }
        },
      });

      const stampFor = (model: ModelId): AIGenerationStamp => ({
        promptId: prompt.id,
        promptVersion: prompt.version,
        job,
        model,
        provider: MODELS[model].provider,
        inputHash,
      });

      if (result.status === "success") {
        return { status: "success", value: result.value, stamp: stampFor(result.model) };
      }
      const last = result.attempts.at(-1);
      return {
        status: "dead-letter",
        reason: result.reason,
        message: result.message,
        rawText: result.rawText,
        stamp: stampFor(last?.model ?? start.model),
      };
    },
  };
}
