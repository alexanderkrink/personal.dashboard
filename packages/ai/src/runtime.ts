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
 * ## What the M1 DoD clause costs, precisely (revised Wave 5, 2026-07-20)
 *
 * "Every AI call appears in `ai_generations` with cost" now has no unmetered *API*. The two
 * escape hatches that used to sit here — `unmeteredLanguageModel()` and
 * `unmeteredProviders()`, reachable only by typing `UNMETERED_ACKNOWLEDGEMENT` — are gone,
 * along with the constant. They existed solely because `streamText` had no metered wrapper;
 * {@link AIRuntime.streamProse} is that wrapper, and it landed before chat/RAG had a single
 * call site, so nothing ever went through the hatches. There is now no way to obtain a raw
 * AI SDK model from this package.
 *
 * ⚠ TWO NARROWER GAPS REMAIN, and neither is closable from inside this file:
 *  1. **An abandoned stream.** `streamProse` writes its row from `onFinish`/`onError`, and
 *     those fire only when the stream is consumed. A caller that starts a stream and drops
 *     it un-read can spend without leaving a row. That is how streaming works — the usage
 *     numbers do not exist until the provider sends them — so the obligation is on the
 *     caller to return the stream rather than discard it.
 *  2. **A transport error inside the structured ladder.** An attempt that dies in transit
 *     never completes, so it never becomes an `AttemptRecord` and produces no row here.
 *     §6 wants it persisted; that belongs in the Inngest step wrapper, where the
 *     `NonRetriableError` decision already lives. `ai_generations.outcome` accepts
 *     `'transport-error'`, so closing it is a code change, not a migration. Earlier
 *     completed rungs ARE metered before it throws. `streamProse` already emits this
 *     outcome, so the value now has a producer.
 *
 * This package never reads `process.env`. `apps/web/src/env.ts` injects both provider keys,
 * the clamp, the guard and the logger.
 */

import { generateObject, type ModelMessage, NoObjectGeneratedError, streamText } from "ai";
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

/**
 * How a metered call ended.
 *
 * The ladder's three outcomes, plus `transport-error` — which the ladder cannot produce
 * (an attempt that dies in transit never completes, so it never becomes an `AttemptRecord`)
 * but a stream can: `streamText` reports a mid-stream failure through `onError` after the
 * request was already made and possibly already billed. `ai_generations.outcome` has
 * accepted this value since 20260719113023; until the streaming wrapper landed it had no
 * producer on this path.
 */
export type GenerationOutcome = AttemptRecord["outcome"] | "transport-error";

/** One `ai_generations` row: the stamp plus what the attempt cost and how it ended. */
export interface AIGenerationRecord extends AIGenerationStamp {
  readonly step: AttemptRecord["step"];
  readonly attempt: number;
  readonly outcome: GenerationOutcome;
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

/**
 * A binary attachment sent alongside the rendered prompt (§4.1's `file` part).
 *
 * Deliberately NOT a `PromptVar`. Vars must stay JSON-serializable because §3 hashes them,
 * and a 9 MB PDF is neither JSON nor something you want stringified into a template. Files
 * travel on their own channel and are folded into `input_hash` by digest — see
 * {@link GenerateStructuredOptions.files}.
 */
export interface PromptFile {
  readonly data: Uint8Array;
  /** Full IANA media type, e.g. `application/pdf`. */
  readonly mediaType: string;
  /** Shown to the model as the file's name. Helps it cite "page 12 of Session 1". */
  readonly filename?: string;
}

export interface GenerateStructuredOptions<TVars extends PromptVars, TSchema extends z.ZodType> {
  readonly prompt: PromptTemplate<TVars>;
  readonly vars: TVars;
  readonly schema: TSchema;
  readonly system?: string;
  /**
   * Binary attachments — the multimodal path (§4.1: "signed URL → fetch bytes in the step
   * → a `file` part → one `generateObject` call").
   *
   * When present the call is sent as a single user *message* whose content is the rendered
   * prompt text followed by each file, instead of as a bare `prompt` string. Everything
   * else is unchanged: the same ladder, the same stamp, the same metering. This exists so
   * that reading a PDF does not require reaching for `unmeteredLanguageModel` — a
   * multimodal escape hatch would be an unmetered escape hatch, and §4.1's extraction is
   * the single most expensive call in the product.
   *
   * ⚠ **Each file's bytes are digested into `input_hash`.** Without that, two different
   * PDFs sent through the same template would hash identically — the rendered text is the
   * same — and §5's idempotency short-circuit would serve one document's extraction for
   * another's. The hash covers what was actually sent, not just the words.
   */
  readonly files?: readonly PromptFile[];
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
 * Prose streamed from the model, metered on completion. The chat/RAG and lesson-prose
 * counterpart to {@link GenerateStructuredOptions}.
 *
 * There is no `schema` and no failure ladder, deliberately: the ladder's rungs are
 * corrective retries against a schema, and prose has no schema to fail. A stream either
 * completes or errors, and both land a row.
 */
export interface StreamProseOptions<TVars extends PromptVars> {
  readonly prompt: PromptTemplate<TVars>;
  readonly vars: TVars;
  readonly system?: string;
  /**
   * Conversation history for chat. When present the rendered prompt becomes the leading
   * system-side instruction and these carry the turns, instead of a bare `prompt` string.
   *
   * ⚠ Hashed into `input_hash` alongside the rendered template, for the same reason
   * `files` are: two different conversations through one template render identically, and a
   * stamp that could not tell them apart would make the §5 idempotency short-circuit serve
   * one user's answer to another's question.
   */
  readonly messages?: readonly ModelMessage[];
  /** Overrides the job derived from `prompt.id`. */
  readonly job?: JobId;
  /**
   * Defaults to `"interactive"` — the opposite of {@link GenerateStructuredOptions.kind}.
   *
   * That default is stricter here, not laxer. A stream exists because a human is watching
   * tokens arrive; calling it `background` would let the §6 budget guard defer it under
   * pressure, and a deferred stream is a chat box that hangs. `interactive` is the honest
   * declaration, and §6 already sheds interactive load last on purpose.
   */
  readonly kind?: CallKind;
}

export interface AIRuntime {
  /** Job → `(provider, model)`, with the `AI_MAX_TIER` clamp applied. Pure; spends nothing. */
  resolve(job: JobId): ModelResolution;
  /** Job → structured output through the §2 failure ladder, fully stamped and metered. */
  generateStructured<TVars extends PromptVars, TSchema extends z.ZodType>(
    options: GenerateStructuredOptions<TVars, TSchema>,
  ): Promise<GenerateStructuredResult<z.infer<TSchema>>>;
  /**
   * Job → streamed prose, fully stamped and metered. The chat/RAG and lesson-prose path.
   *
   * Same gates as `generateStructured`, in the same order: kill switch first and
   * synchronously, then the §6 budget decision, both **before** the request is made. One
   * `ai_generations` row lands per call — `success` with usage from `onFinish`, or
   * `transport-error` with the message from `onError`, whichever settles first.
   *
   * ⚠ **The row is written when the stream settles, not when this returns.** `onFinish`
   * fires only if the stream is actually consumed, so a caller that creates a stream and
   * abandons it un-read can still spend without leaving a row. Route handlers must return
   * the stream to the client (which consumes it) rather than dropping it on an early
   * return. This is the one remaining gap in "every AI call appears in `ai_generations`"
   * and it is a property of how streaming works, not something the wrapper can close.
   */
  streamProse<TVars extends PromptVars>(
    options: StreamProseOptions<TVars>,
  ): Promise<ReturnType<typeof streamText>>;
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
  return digestHex(new TextEncoder().encode(input));
}

/** SHA-256 hex of raw bytes. The file half of `input_hash`. */
export async function sha256HexBytes(input: Uint8Array): Promise<string> {
  return digestHex(input);
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  // `.slice()` produces a plain ArrayBuffer view even when `bytes` is a view onto a
  // SharedArrayBuffer or a pooled Node Buffer, which `digest` refuses.
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer);
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
    const reading = await config.guard.monthToDateSpend();
    return guardDecision({
      killSwitch: false,
      posture: spendPosture({
        monthToDateUsd: reading.costUsd,
        // Forwarded, not dropped. A reading that knows part of the month is unpriced and a
        // guard that never asks is the same bug as the view's old coalesce, one layer up.
        unpricedCalls: reading.unpricedCalls,
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
    async streamProse<TVars extends PromptVars>({
      prompt,
      vars,
      system,
      messages,
      job: jobOverride,
      kind,
    }: StreamProseOptions<TVars>): Promise<ReturnType<typeof streamText>> {
      // Same order as `generateStructured`, for the same reasons. Kill switch first and
      // synchronously; budget decision before a single token is spent.
      //
      // ⚠ This line is REDUNDANT today and no test discriminates it: `decide()` below also
      // checks `killSwitch` and returns before awaiting the rollup, so deleting this line
      // changes no observable behaviour (verified by mutation, Wave 5). It is kept as
      // defence in depth — the property "flip one env var and nothing even touches the
      // database" currently rests on `decide()`'s internal ordering, which is an
      // implementation detail of a different function. Deleting BOTH checks does fail
      // `runtime.test.ts`, so the property is covered even though this line is not.
      if (config.guard.killSwitch) throw new AIPausedError("kill-switch");

      const job = jobOverride ?? jobForPromptId(prompt.id);
      if (job === undefined) {
        throw new Error(
          `Prompt id "${prompt.id}" does not resolve to a job. Per §3 a prompt id must equal the key of the job that runs it.`,
        );
      }

      const decision = await decide(job, kind ?? "interactive");
      if (!decision.allowed) throw new AIPausedError(decision.reason, { job });

      const rendered = prompt.render(vars);
      const inputHash = await sha256Hex(
        `${prompt.id}@${prompt.version}\n${rendered}${
          messages === undefined ? "" : `\n\nmessages:\n${JSON.stringify(messages)}`
        }`,
      );
      const resolved = resolve(job);
      const startedAt = Date.now();

      // `onFinish` and `onError` can both fire on a stream that errors after partial
      // output. Exactly one row per call, so whichever settles first wins — a second row
      // would double-count the spend the §6 rollup reads.
      let settled = false;
      const emit = async (
        outcome: GenerationOutcome,
        usage: TokenUsage | undefined,
        errorMessage?: string,
      ): Promise<void> => {
        if (settled) return;
        settled = true;
        await config.log({
          promptId: prompt.id,
          promptVersion: prompt.version,
          job,
          model: resolved.model,
          provider: MODELS[resolved.model].provider,
          inputHash,
          step: "initial",
          // No ladder: prose has no schema to fail, so there is nothing to retry
          // correctively and never more than one attempt.
          attempt: 1,
          outcome,
          ...(usage === undefined ? {} : { usage }),
          latencyMs: Date.now() - startedAt,
          ...(errorMessage === undefined ? {} : { errorMessage }),
        });
      };

      return streamText({
        model: languageModelFor(providers, resolved.model),
        ...(system === undefined ? {} : { system }),
        ...(messages === undefined
          ? { prompt: rendered }
          : { messages: [...messages], system: system === undefined ? rendered : system }),
        onFinish: async ({ usage }) => {
          await emit("success", toTokenUsage(usage));
        },
        onError: async ({ error }) => {
          await emit(
            "transport-error",
            undefined,
            error instanceof Error ? error.message : String(error),
          );
        },
      });
    },

    async generateStructured<TVars extends PromptVars, TSchema extends z.ZodType>({
      prompt,
      vars,
      schema,
      system,
      files,
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
      // Files contribute their digest, in order, so `input_hash` identifies the whole
      // request rather than just its words. See `GenerateStructuredOptions.files`.
      const fileDigests = await Promise.all(
        (files ?? []).map(async (file) => `${file.mediaType}:${await sha256HexBytes(file.data)}`),
      );
      const inputHash = await sha256Hex(
        `${prompt.id}@${prompt.version}\n${rendered}${
          fileDigests.length === 0 ? "" : `\n\nfiles:\n${fileDigests.join("\n")}`
        }`,
      );
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
              // Text-only stays on the plain `prompt` string — the shape every existing
              // call and every existing test already exercises. Attachments switch to a
              // single user message, with the text FIRST: the instructions have to be in
              // context before the model starts reading 40 pages, or the read is
              // unconditioned and the schema does all the steering.
              ...(files === undefined || files.length === 0
                ? { prompt: promptText }
                : {
                    messages: [
                      {
                        role: "user" as const,
                        content: [
                          { type: "text" as const, text: promptText },
                          ...files.map((file) => ({
                            type: "file" as const,
                            data: file.data,
                            mediaType: file.mediaType,
                            ...(file.filename === undefined ? {} : { filename: file.filename }),
                          })),
                        ],
                      },
                    ],
                  }),
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
