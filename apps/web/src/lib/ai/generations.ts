/**
 * The `ai_generations` writer (PLAN.md §AI Strategy §3, §5).
 *
 * This is the implementation behind `AIRuntimeConfig.log`. It receives an
 * already-complete `AIGenerationRecord` — the five-column stamp, the token usage, the
 * latency, the outcome and the raw text are all assembled by the call wrapper in
 * `packages/ai`, so there is nothing here that a caller could have gotten wrong. All this
 * function does is price the attempt and insert the row.
 */

import type { AIGenerationLogger, AIGenerationRecord, ModelId } from "@study/ai";
import { priceUsd } from "@study/ai";
import type { SupabaseAdminClient, TablesInsert } from "@study/db";

/**
 * `priceUsd` is typed against the registry's model IDs, and the record carries one — but
 * the record could in principle be read back from somewhere widened to `string`. This
 * narrows without asserting, so an unknown model logs with a NULL cost rather than
 * throwing and losing the row entirely. A row with an unknown cost is recoverable; a call
 * that happened and left no trace is not.
 */
function priceOrNull(model: ModelId, record: AIGenerationRecord): number | null {
  if (record.usage === undefined) return null;
  try {
    return priceUsd(model, record.usage);
  } catch {
    return null;
  }
}

export function toGenerationRow(
  userId: string,
  record: AIGenerationRecord,
): TablesInsert<"ai_generations"> {
  const usage = record.usage;
  return {
    user_id: userId,
    // ── The §3 five-column stamp ───────────────────────────────────────────────
    prompt_id: record.promptId,
    prompt_version: record.promptVersion,
    provider: record.provider,
    model: record.model,
    input_hash: record.inputHash,
    // ── The §3 sixth column ────────────────────────────────────────────────────
    // What input_hash cannot see: the output contract. NULL for prose (no schema) and for
    // any record that predates the column being threaded through the runtime.
    schema_hash: record.schemaHash ?? null,
    // ── Where in the ladder ────────────────────────────────────────────────────
    job: record.job,
    step: record.step,
    attempt: record.attempt,
    outcome: record.outcome,
    // ── §5 token usage ─────────────────────────────────────────────────────────
    input_tokens: usage?.input ?? 0,
    output_tokens: usage?.output ?? 0,
    cache_read_tokens: usage?.cacheRead ?? 0,
    cache_write_tokens: usage?.cacheWrite ?? 0,
    latency_ms: Math.round(record.latencyMs),
    // Priced here rather than in SQL: pricing.ts is the single source of truth and it
    // already models Gemini Pro's >200K bracket and Sonnet's opt-in intro rates. No
    // options are passed, deliberately — the durable sticker, no batch discount. Both
    // defaults are the conservative ones: budgeting against a promotional rate that
    // expires on 2026-08-31 is how you get surprised in September.
    cost_usd: priceOrNull(record.model, record),
    // ── §2 rung 3 evidence ─────────────────────────────────────────────────────
    raw_text: record.rawText ?? null,
    error_message: record.errorMessage ?? null,
  };
}

/**
 * Builds the logger for one user.
 *
 * Uses the admin client: metering has to succeed for calls made by background jobs, which
 * have no session to derive RLS from. Every row still carries the owning `user_id` — the
 * §RLS-strategy rule that multi-user correctness never depends on there being one user.
 *
 * Throws on failure rather than swallowing. An unmetered call is a hole in the budget
 * guard, and a guard that silently under-counts is worse than no guard: it reports safety
 * it cannot deliver. `AIRuntimeConfig.log` is awaited precisely so this surfaces.
 */
export function createGenerationLogger(
  client: SupabaseAdminClient,
  userId: string,
): AIGenerationLogger {
  return async (record) => {
    const { error } = await client.from("ai_generations").insert(toGenerationRow(userId, record));
    if (error !== null) {
      throw new Error(
        `Failed to log ai_generations row for ${record.promptId}@${record.promptVersion} (${record.provider}/${record.model}): ${error.message}`,
      );
    }
  };
}
