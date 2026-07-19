/**
 * Month-to-date AI spend, read from the §6 `ai_daily_cost` rollup.
 *
 * This is the input to the budget guard. It is deliberately the *view* rather than a
 * hand-rolled sum over `ai_generations`: §6 asks for one rollup that everything reads, so
 * the guard, a future dashboard and a psql session cannot disagree about what a day cost.
 */

import { wallClockAt } from "@study/core";
import type { SupabaseAdminClient } from "@study/db";
import { z } from "zod";

/** The app's civil calendar, per the calendar spine's §3.4 decision. */
export const APP_TIMEZONE = "Europe/Madrid";

/**
 * First day of the current month **in Madrid**, as `YYYY-MM-01`.
 *
 * `ai_daily_cost.day` is already a Madrid-local date, so the boundary has to be computed
 * in the same zone. Doing it in UTC would drop the first hours of the 1st of the month —
 * every call made between 00:00 and 02:00 Madrid time would still be billed to the
 * previous month's budget, which is exactly the kind of quiet off-by-a-day that makes a
 * cap look like it is working when it is not.
 */
export function monthStartInAppTimezone(now: Date = new Date()): string {
  const wall = wallClockAt(now.getTime(), APP_TIMEZONE);
  return `${String(wall.year).padStart(4, "0")}-${String(wall.month).padStart(2, "0")}-01`;
}

/**
 * ⚠ `cost_usd` is `numeric` in Postgres, and **PostgREST serializes numeric as a JSON
 * string** to avoid the precision loss of a float. The generated `Database` type claims
 * `number | null`, which is a lie the type system will happily let through — `sum + row`
 * would concatenate strings and produce a spend figure of `"00.000123"`.
 *
 * Verified against the linked project, not assumed. `z.coerce.number()` is the boundary
 * that makes the generated type true, per the repo's "Zod at every boundary" rule.
 */
const dailyCostRow = z.object({
  cost_usd: z.coerce.number().nullable(),
});

/**
 * Sums the rollup for this user, this month. Returns USD.
 *
 * Errors propagate. A caller that cannot read the rollup should not silently assume $0 —
 * `spendPosture` treats a non-finite figure as `normal` on purpose (one uncapped call
 * beats every AI feature going dark on a transient hiccup), but that decision belongs to
 * the guard, made explicitly, not to a swallowed catch here.
 */
export async function readMonthToDateSpendUsd(
  client: SupabaseAdminClient,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const { data, error } = await client
    .from("ai_daily_cost")
    .select("cost_usd")
    .eq("user_id", userId)
    .gte("day", monthStartInAppTimezone(now));

  if (error !== null) {
    throw new Error(`Failed to read ai_daily_cost for the budget guard: ${error.message}`);
  }

  return (data ?? []).reduce((total, row) => total + (dailyCostRow.parse(row).cost_usd ?? 0), 0);
}

/** How long a spend reading is reused before the rollup is queried again. */
export const SPEND_CACHE_TTL_MS = 30_000;

/**
 * A cached reader, one per runtime.
 *
 * The guard consults this once per `generateStructured` call, and a document-pipeline run
 * makes dozens — a database round trip in front of every LLM request would be a real
 * latency tax for a number that moves by fractions of a cent.
 *
 * 30 seconds is chosen against what it can cost: at the most expensive job in the
 * registry (Opus at ~$0.50/run, §4) a fully stale window is worth a few dollars of
 * overshoot on a $75 cap, and the very next call sees the true figure. A cache that never
 * expired, or one scoped globally rather than per runtime, would not have that ceiling.
 */
export function createCachedSpendReader(
  client: SupabaseAdminClient,
  userId: string,
  options?: { ttlMs?: number; now?: () => number },
): () => Promise<number> {
  const ttlMs = options?.ttlMs ?? SPEND_CACHE_TTL_MS;
  const now = options?.now ?? (() => Date.now());
  let cachedAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<number> | undefined;
  let value = 0;

  return async () => {
    if (now() - cachedAt < ttlMs) return value;
    // Collapse concurrent reads: a pipeline step that fans out ten calls at once should
    // make one query, not ten identical ones.
    inflight ??= readMonthToDateSpendUsd(client, userId, new Date(now()))
      .then((fresh) => {
        value = fresh;
        cachedAt = now();
        return fresh;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
}
