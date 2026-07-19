/**
 * The embedding client (PLAN "Document & Notes Pipeline" §6, AI Strategy §1/§5).
 *
 * > The embedding client lives in `packages/ai` behind an `embed(texts, inputType)`
 * > interface so the provider is swappable.
 *
 * This is that interface, and it is the **first** embedding call in the project. Two things
 * follow from being first, and both are deliberate design decisions rather than
 * implementation details:
 *
 * ## 1. Embeddings are a separate axis from the two LLM families
 *
 * `getModel(job)` resolves *language* models and `ProviderName` is narrowed to
 * `anthropic | google` precisely so an embedding model cannot typecheck as one and get
 * handed to `generateObject`. So embeddings do not go through `JOBS`, do not go through
 * `generateStructured`, and do not enter the §2 failure ladder — there is no structured
 * output to fail, no corrective retry that would mean anything, and escalating to "a bigger
 * embedding model" would produce vectors that are not comparable with the ones already in
 * the database, which is the one thing §5 says never to do.
 *
 * What they emphatically DO share is metering. `ai_generations.provider` was widened to
 * admit `voyage` for exactly this call, and the M1 DoD sentence — every AI call appears in
 * `ai_generations` with a cost — covers retrieval as much as generation.
 *
 * ## 2. Metering is structural here too
 *
 * `log` is a **required** config field, same as on `AIRuntimeConfig` and for the same
 * reason: there must be no way to construct something that spends money without a metering
 * sink. `killSwitch` is required for the same reason — §6's promise is "one env var stops
 * all spend", and a spend path that ignores the switch makes that promise false rather than
 * merely incomplete.
 *
 * The **budget guard** is deliberately not applied. `guardDecision` needs a `rank`, which
 * is a property of the language-model ladder that embeddings are not on, and inventing one
 * would mean inventing a position in an escalation order that does not exist for them. The
 * exposure this leaves is bounded and stated: at $0.02/MTok with the first 200M tokens
 * free, a runaway loop here costs cents where the same loop on `doc-structuring` costs
 * hundreds of dollars, and the kill switch still stops it outright.
 *
 * This module never reads `process.env`. `apps/web/src/lib/ai/embeddings.ts` injects the
 * key, the switch and the logger.
 */

import { type EmbeddingModelId, embeddingPriceUsd } from "./pricing";

/**
 * The slice of the Fetch standard this client uses.
 *
 * A real exported type rather than the ambient one in `web-globals.d.ts`: that file is not
 * in `apps/web`'s tsconfig include set, so a name declared there does not exist when the
 * app typechecks this source. Exported types cross the boundary; ambient ones do not.
 *
 * Narrow on purpose — a test double implements four members, not the whole standard.
 */
export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface FetchRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export type FetchLike = (url: string, init?: FetchRequestInit) => Promise<FetchResponse>;

import { sha256Hex } from "./runtime";

/** The pinned embedding model. One vendor, one model — see §5 on vector comparability. */
export const EMBEDDING_MODEL = "voyage-3.5-lite" satisfies EmbeddingModelId;

/** Voyage's default output width for this model, and the width of every `vector(1024)`. */
export const EMBEDDING_DIMENSIONS = 1024;

/**
 * Voyage's asymmetric retrieval hint.
 *
 * `document` for anything being indexed, `query` for anything being searched *with*. Using
 * the wrong one silently degrades recall rather than erroring, which is why it is a
 * required argument with no default: a caller that has not thought about which side of the
 * retrieval it is on is a caller that will pick wrong.
 */
export type EmbeddingInputType = "document" | "query";

/**
 * How the call is attributed in `ai_generations`.
 *
 * `prompt_id` and `job` are `not null` on that table with a kebab-case check, so an
 * embedding — which has no `definePrompt` template and no `JOBS` entry — still has to name
 * itself. It names itself after **what it is embedding**, which is the only thing that
 * makes the §6 rollup's `group by job` informative: "routing spent $0.004 and chunking
 * spent $0.31" is a useful sentence, "embedding spent $0.314" is not.
 *
 * Adding a purpose is the intended extension point. Chunk embedding (PLAN §6, a different
 * agent's deliverable) adds `"embed-chunk"` here and changes nothing else — the client, the
 * metering, the pricing and the logger are all already correct for it.
 *
 * ⚠ These are NOT `JobId`s and must never be added to `JOBS`. See the module note.
 */
export const EMBEDDING_PURPOSES = [
  /** Routing: one vector per candidate segment (§5 Step A.2). */
  "embed-segment",
  /** The duplicate guard: one vector per proposed new topic title (§5 Step A.4). */
  "embed-topic-title",
  /** Routing retrieval + refreshed on every merge (§5 Step C). */
  "embed-topic-summary",
  /** RAG chunks (§6). */
  "embed-chunk",
  /** Search-side vectors. The only `query` input type. */
  "embed-query",
] as const;

export type EmbeddingPurpose = (typeof EMBEDDING_PURPOSES)[number];

/**
 * The version of the *recipe*, not of a prompt.
 *
 * `prompt_version` is `not null` on `ai_generations` and the §3 stamp is meant to answer
 * "what produced this vector". For an embedding the answer is the model plus how the input
 * was prepared, so this bumps if the normalization changes or the model is re-pinned —
 * which is exactly when previously stored vectors stop being comparable and everything
 * needs re-embedding. It is the flag that makes that re-embed findable
 * (`where prompt_id like 'embed-%' and prompt_version < 2`).
 */
export const EMBEDDING_RECIPE_VERSION = 1;

/** One `ai_generations` row for an embedding call. Mirrors `AIGenerationRecord`'s shape. */
export interface EmbeddingGenerationRecord {
  readonly promptId: EmbeddingPurpose;
  readonly promptVersion: number;
  readonly job: EmbeddingPurpose;
  readonly provider: "voyage";
  readonly model: string;
  readonly inputHash: string;
  readonly outcome: "success" | "transport-error";
  readonly inputTokens: number;
  readonly costUsd: number | null;
  readonly latencyMs: number;
  readonly errorMessage?: string;
}

export type EmbeddingLogger = (record: EmbeddingGenerationRecord) => void | Promise<void>;

export interface EmbeddingClientConfig {
  readonly apiKey: string;
  /** Required. There is no way to build an embedding client with no metering sink. */
  readonly log: EmbeddingLogger;
  /** Required. §6's kill switch reaches every path that can spend, including this one. */
  readonly killSwitch: boolean;
  /** Injected for tests. Production leaves it undefined and gets the ambient `fetch`. */
  readonly fetchImpl?: FetchLike;
  /** Inputs per HTTP request. Voyage accepts far more; this bounds one request's blast radius. */
  readonly batchSize?: number;
  /**
   * First rate-limit backoff step, doubling per retry. Injected so the backoff tests assert
   * the retry *behaviour* without spending seven real seconds asserting that sleep sleeps.
   */
  readonly retryDelayMs?: number;
}

export interface EmbedOptions {
  readonly texts: readonly string[];
  readonly inputType: EmbeddingInputType;
  readonly purpose: EmbeddingPurpose;
}

export interface EmbedResult {
  /** One vector per input, in input order. Same length as `texts`, always. */
  readonly embeddings: readonly (readonly number[])[];
  readonly model: string;
  readonly totalTokens: number;
  /** Summed across every batch. Never null — see `embeddingPriceUsd`. */
  readonly costUsd: number;
}

export interface EmbeddingClient {
  embed(options: EmbedOptions): Promise<EmbedResult>;
}

/** Thrown when AI is paused. Mirrors `AIPausedError` without importing the guard's shape. */
export class EmbeddingsPausedError extends Error {
  constructor() {
    super("AI features are paused (AI_KILL_SWITCH), so no embeddings were requested.");
    this.name = "EmbeddingsPausedError";
  }
}

export class VoyageEmbeddingError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "VoyageEmbeddingError";
  }
}

const VOYAGE_ENDPOINT = "https://api.voyageai.com/v1/embeddings";
const DEFAULT_BATCH_SIZE = 96;

/** Total tries for one batch, including the first. See the backoff note in `embed`. */
export const RATE_LIMIT_ATTEMPTS = 4;
/** First backoff step; doubles each retry (1s, 2s, 4s → ~7s of patience total). */
export const RATE_LIMIT_BASE_DELAY_MS = 1_000;

/**
 * `setTimeout` as a promise, without depending on a timer global's type.
 *
 * `web-globals.d.ts` deliberately declares only the handful of globals this package uses,
 * and `setTimeout`'s signature differs between node and the DOM (a `Timeout` object versus
 * a number). Reaching for either lib to get a sleep would drag the whole environment in, so
 * the one call site casts a structurally-minimal binding instead.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => unknown }).setTimeout(
      resolve,
      ms,
    );
  });
}

/** Voyage's response, as much of it as this module relies on. */
interface VoyageResponse {
  readonly data?: readonly { readonly index?: number; readonly embedding?: readonly number[] }[];
  readonly model?: string;
  readonly usage?: { readonly total_tokens?: number };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function createEmbeddingClient(config: EmbeddingClientConfig): EmbeddingClient {
  const batchSize = Math.max(1, config.batchSize ?? DEFAULT_BATCH_SIZE);
  const doFetch = config.fetchImpl ?? fetch;
  const retryDelayMs = config.retryDelayMs ?? RATE_LIMIT_BASE_DELAY_MS;

  return {
    async embed({ texts, inputType, purpose }: EmbedOptions): Promise<EmbedResult> {
      // First, before anything is sent. Same ordering as `generateStructured`.
      if (config.killSwitch) throw new EmbeddingsPausedError();

      if (texts.length === 0) {
        return { embeddings: [], model: EMBEDDING_MODEL, totalTokens: 0, costUsd: 0 };
      }

      const embeddings: (readonly number[])[] = [];
      let totalTokens = 0;
      let costUsd = 0;

      for (const batch of chunk(texts, batchSize)) {
        // The stamp's `input_hash` covers what was actually sent, in order, plus the two
        // things that change the meaning of the same words: the model and the input type.
        // A `document` vector and a `query` vector of identical text are different vectors.
        const inputHash = await sha256Hex(
          `${EMBEDDING_MODEL}\n${inputType}\n${EMBEDDING_RECIPE_VERSION}\n${batch.join("\n \n")}`,
        );
        const startedAt = Date.now();

        /** One `ai_generations` row per HTTP request — the unit that is actually billed. */
        const emit = async (
          outcome: "success" | "transport-error",
          tokens: number,
          errorMessage?: string,
        ): Promise<void> => {
          await config.log({
            promptId: purpose,
            promptVersion: EMBEDDING_RECIPE_VERSION,
            job: purpose,
            provider: "voyage",
            model: EMBEDDING_MODEL,
            inputHash,
            outcome,
            inputTokens: tokens,
            costUsd: outcome === "success" ? embeddingPriceUsd(EMBEDDING_MODEL, tokens) : null,
            latencyMs: Date.now() - startedAt,
            ...(errorMessage === undefined ? {} : { errorMessage }),
          });
        };

        // ── The request, with bounded backoff on a rate limit ─────────────────
        //
        // 🔴 MEASURED: Voyage rate-limits this account hard. Three embedding requests
        // inside ~14 seconds — a perfectly ordinary two-document pipeline run — returned
        // **HTTP 429**, which failed the routing step and took the whole document with it.
        //
        // Retrying here rather than leaving it to Inngest's step retry is deliberate. An
        // Inngest retry re-runs the ENTIRE step, which for `route-and-merge` means paying
        // for the routing call and every completed Sonnet merge again. A rate limit is the
        // one error where the correct response is simply to wait a moment, and the cheapest
        // possible place to wait is here, before anything expensive has happened.
        //
        // Bounded at {@link RATE_LIMIT_ATTEMPTS} and never applied to any other status: a
        // 401 is not going to fix itself, and a client that retried it would turn a
        // misconfiguration into a slow one.
        let response: FetchResponse | undefined;
        let lastStatus = 0;
        let lastBody = "";

        for (let attempt = 1; attempt <= RATE_LIMIT_ATTEMPTS; attempt += 1) {
          try {
            response = await doFetch(VOYAGE_ENDPOINT, {
              method: "POST",
              headers: {
                authorization: `Bearer ${config.apiKey}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                model: EMBEDDING_MODEL,
                input: batch,
                input_type: inputType,
                output_dimension: EMBEDDING_DIMENSIONS,
              }),
            });
          } catch (error) {
            // A failed request is still an event worth a row: `ai_generations` is the only
            // place a reader can see that embedding was attempted and did not happen.
            const message = error instanceof Error ? error.message : String(error);
            await emit("transport-error", 0, message);
            throw new VoyageEmbeddingError(`Voyage request failed: ${message}`);
          }

          if (response.ok) break;

          lastStatus = response.status;
          lastBody = await response.text().catch(() => "");

          const retriable = response.status === 429 || response.status >= 500;
          if (!retriable || attempt === RATE_LIMIT_ATTEMPTS) {
            await emit("transport-error", 0, `HTTP ${lastStatus}: ${lastBody.slice(0, 300)}`);
            throw new VoyageEmbeddingError(
              `Voyage returned ${lastStatus} for ${batch.length} input(s) after ${attempt} attempt(s).`,
              lastStatus,
            );
          }

          await sleep(retryDelayMs * 2 ** (attempt - 1));
        }

        if (response === undefined || !response.ok) {
          await emit("transport-error", 0, `HTTP ${lastStatus}: ${lastBody.slice(0, 300)}`);
          throw new VoyageEmbeddingError(
            `Voyage returned ${lastStatus} for ${batch.length} input(s).`,
            lastStatus,
          );
        }

        const parsed = (await response.json()) as VoyageResponse;
        const tokens = parsed.usage?.total_tokens ?? 0;
        const rows = parsed.data ?? [];

        // Order is a correctness property, not a convenience: the caller pairs vectors back
        // to segments by position. Voyage returns an explicit `index`, so it is used rather
        // than trusting array order, and a batch that comes back short throws instead of
        // silently shifting every subsequent vector onto the wrong segment.
        const byIndex = new Map<number, readonly number[]>();
        rows.forEach((row, position) => {
          const vector = row.embedding;
          if (vector === undefined) return;
          byIndex.set(row.index ?? position, vector);
        });

        for (let i = 0; i < batch.length; i += 1) {
          const vector = byIndex.get(i);
          if (vector === undefined || vector.length !== EMBEDDING_DIMENSIONS) {
            await emit("transport-error", tokens, `Missing or mis-sized vector at index ${i}`);
            throw new VoyageEmbeddingError(
              `Voyage returned ${byIndex.size} usable vectors for ${batch.length} inputs (index ${i} missing or not ${EMBEDDING_DIMENSIONS}-dim).`,
            );
          }
          embeddings.push(vector);
        }

        await emit("success", tokens);
        totalTokens += tokens;
        costUsd += embeddingPriceUsd(EMBEDDING_MODEL, tokens);
      }

      return { embeddings, model: EMBEDDING_MODEL, totalTokens, costUsd };
    },
  };
}
