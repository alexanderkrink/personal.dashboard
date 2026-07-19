/**
 * The one place in the app that builds an `EmbeddingClient`.
 *
 * Mirrors `./runtime.ts` exactly, and for the same reason: `packages/ai` never reads
 * `process.env`, so the key, the kill switch and the `ai_generations` writer are all
 * injected here. A `userId` is required for the same reason it is there — a call nobody
 * owns is a call the rollup cannot attribute.
 *
 * ## For whoever builds chunk embedding next
 *
 * This is the embedding entry point; do not build a second one. Everything the chunking
 * step needs already works here — batching, ordering, metering, pricing, the kill switch —
 * and `"embed-chunk"` is already a valid `EmbeddingPurpose`. A parallel client would mean
 * two code paths writing `ai_generations` rows with different stamps, and the first time
 * they disagree the §6 rollup silently under-reports.
 *
 * Reading the vectors back out of Postgres is the one thing the client does not do, because
 * it is a database concern rather than a provider one — see {@link parseStoredVector}.
 */

import type { EmbeddingClient, EmbeddingGenerationRecord } from "@study/ai";
import { createEmbeddingClient, EMBEDDING_DIMENSIONS } from "@study/ai";
import { createAdminSupabaseClient, type SupabaseAdminClient, type TablesInsert } from "@study/db";
import { env } from "@/env";

/**
 * Thrown when `VOYAGE_API_KEY` is unset. Distinct from a paused runtime: paused means "not
 * now", this means "not configured".
 */
export class EmbeddingsNotConfiguredError extends Error {
  constructor() {
    super(
      "Embeddings are not configured: VOYAGE_API_KEY is unset. Routing cannot retrieve topic candidates without it.",
    );
    this.name = "EmbeddingsNotConfiguredError";
  }
}

/**
 * An embedding attempt, as an `ai_generations` row.
 *
 * Deliberately shaped by hand rather than routed through `toGenerationRow`: that function
 * takes an `AIGenerationRecord`, whose `provider` is narrowed to the two *language* model
 * families and whose `model` is a `ModelId`. Widening it to admit Voyage would relax the
 * type that stops an embedding model being handed to `generateObject`, which is the exact
 * protection `models.ts` documents at length. Two small mappers beat one loose one.
 *
 * `step` is `'initial'` and `attempt` is `1` on every row because embeddings do not enter
 * the §2 ladder — there is no structured output to fail and no cross-family escalation that
 * would preserve vector comparability. The columns are `not null`, so they say so honestly
 * rather than pretending to a rung that does not exist.
 */
function toEmbeddingRow(
  userId: string,
  record: EmbeddingGenerationRecord,
): TablesInsert<"ai_generations"> {
  return {
    user_id: userId,
    prompt_id: record.promptId,
    prompt_version: record.promptVersion,
    provider: record.provider,
    model: record.model,
    input_hash: record.inputHash,
    job: record.job,
    step: "initial",
    attempt: 1,
    outcome: record.outcome,
    input_tokens: record.inputTokens,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    latency_ms: Math.round(record.latencyMs),
    cost_usd: record.costUsd,
    raw_text: null,
    error_message: record.errorMessage ?? null,
  };
}

export function createStudyEmbeddingClient({ userId }: { userId: string }): EmbeddingClient {
  const apiKey = env.VOYAGE_API_KEY;
  if (apiKey === undefined) throw new EmbeddingsNotConfiguredError();

  const admin = createAdminSupabaseClient({
    url: env.NEXT_PUBLIC_SUPABASE_URL,
    secretKey: env.SUPABASE_SECRET_KEY,
  });

  return createEmbeddingClient({
    apiKey,
    // Tighten-only, same asymmetry as the runtime's: the environment can stop spend, and
    // nothing here can restart it.
    killSwitch: env.AI_KILL_SWITCH,
    log: async (record) => {
      const { error } = await admin.from("ai_generations").insert(toEmbeddingRow(userId, record));
      if (error !== null) {
        throw new Error(
          `Failed to log ai_generations row for ${record.promptId} (voyage/${record.model}): ${error.message}`,
        );
      }
    },
  });
}

/**
 * Serializes a vector for a `extensions.vector(1024)` column.
 *
 * pgvector's text input format is a bracketed, comma-separated list, and PostgREST sends
 * the column as a string in both directions — which is why `topics.title_embedding` is
 * typed `string | null` in the generated types rather than as an array.
 */
export function toStoredVector(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

/**
 * Reads a vector back out of a `vector(1024)` column.
 *
 * Returns `null` for anything that is not a usable 1024-dim vector, and that is the whole
 * point: a malformed or wrong-width vector must reach the duplicate guard as "no vector"
 * rather than as a short array. `cosineSimilarity` already refuses to compare mismatched
 * widths, but it can only do that if the mismatch survives to it — a parser that returned a
 * best-effort short array would turn a real problem into a plausible-looking similarity.
 */
export function parseStoredVector(value: string | null): number[] | null {
  if (value === null || value === "") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== EMBEDDING_DIMENSIONS) return null;
    const numbers: number[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "number" || !Number.isFinite(entry)) return null;
      numbers.push(entry);
    }
    return numbers;
  } catch {
    return null;
  }
}

export type { SupabaseAdminClient };
