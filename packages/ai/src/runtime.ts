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
 *   handed to `log` with the full stamp, token usage and latency attached.
 *
 * ┌─ INSERTION POINT FOR M1 ITEM 2c (Agent 3) ────────────────────────────────────────┐
 * │ `AIRuntimeConfig.log` is the one hook the `ai_generations` writer plugs into.       │
 * │ It is called once per ladder attempt from `emit()` below, with an already-complete  │
 * │ `AIGenerationRecord` — nothing is left for the implementer to assemble, which is    │
 * │ what makes the stamp structurally impossible to forget rather than merely required. │
 * │ The kill switch and the budget guard belong at the top of `generateStructured`,     │
 * │ before the first `getModel` call — see the marked comment there.                    │
 * └────────────────────────────────────────────────────────────────────────────────────┘
 *
 * This package never reads `process.env`. `apps/web/src/env.ts` injects both provider keys,
 * the clamp and the logger.
 */

import { generateObject, NoObjectGeneratedError } from "ai";
import type { z } from "zod";
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
 * Agent 3 implements this against the `ai_generations` table.
 *
 * Awaited, so a logging failure surfaces rather than vanishing into an unhandled rejection —
 * an unmetered call is a hole in the budget guard, not a cosmetic problem.
 */
export type AIGenerationLogger = (record: AIGenerationRecord) => void | Promise<void>;

export interface AIRuntimeConfig {
  readonly anthropicApiKey: string;
  readonly googleApiKey: string;
  /** ⇦ Agent 3's `ai_generations` writer plugs in here. */
  readonly log?: AIGenerationLogger;
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

export interface AIRuntime {
  /** Job → `(provider, model)`, with the `AI_MAX_TIER` clamp applied. */
  resolve(job: JobId): ModelResolution;
  /** Job → an AI SDK language model. For `streamText` (chat/RAG, lesson prose). */
  languageModel(job: JobId): ReturnType<typeof languageModelFor>;
  /** Job → structured output through the §2 failure ladder, fully stamped and metered. */
  generateStructured<TVars extends PromptVars, TSchema extends z.ZodType>(
    options: GenerateStructuredOptions<TVars, TSchema>,
  ): Promise<GenerateStructuredResult<z.infer<TSchema>>>;
  readonly providers: AIProviders;
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

  return {
    providers,
    resolve,
    languageModel: (job) => languageModelFor(providers, resolve(job).model),

    async generateStructured<TVars extends PromptVars, TSchema extends z.ZodType>({
      prompt,
      vars,
      schema,
      system,
      job: jobOverride,
    }: GenerateStructuredOptions<TVars, TSchema>): Promise<
      GenerateStructuredResult<z.infer<TSchema>>
    > {
      // ⇦ Agent 3: AI_KILL_SWITCH and the AI_MONTHLY_BUDGET_USD guard go HERE, before any
      // model is resolved and before any token is spent. Failing fast at this line is what
      // makes "flip one Vercel env var" stop all spend.

      const job = jobOverride ?? jobForPromptId(prompt.id);
      if (job === undefined) {
        throw new Error(
          `Prompt id "${prompt.id}" does not resolve to a job. Per §3 a prompt id must equal the key of the job that runs it.`,
        );
      }

      const rendered = prompt.render(vars);
      const inputHash = await sha256Hex(`${prompt.id}@${prompt.version}\n${rendered}`);
      const start = resolve(job);

      const emit = async (record: AttemptRecord): Promise<void> => {
        if (config.log === undefined) return;
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

      // Metering is structural: every attempt the ladder took is logged here, not at any
      // call site. Sequential so `ai_generations` rows land in attempt order.
      for (const record of result.attempts) await emit(record);

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
