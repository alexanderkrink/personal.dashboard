// @vitest-environment node
//
// Node, not the jsdom default: extract.ts's import graph reaches `@/env`, and t3-env refuses
// to hand a server variable to anything with a `window` on it.

import type { SupabaseAdminClient } from "@study/db";
import { describe, expect, it, vi } from "vitest";

// `extractionCost` is a pure function of its arguments and never reads config, but extract.ts
// imports `@/env` at module load, whose t3-env validation would otherwise fail the import.
// Stub it away (same pattern as feed-delete-path.test.ts).
vi.mock("@/env", () => ({ env: {} }));

import { extractionCost } from "./extract";

/**
 * The `extract` step's cost display (PLAN §7), scoped correctly.
 *
 * `extractionCost` reads what the extraction cost back out of `ai_generations`, keyed on the
 * call's `input_hash`. `input_hash` is deterministic in (prompt, version, content), so a step
 * retry — extract.ts's own docstring: "a transport failure after a successful generateObject
 * re-runs the call" — or a reprocess writes FRESH rows under the SAME hash. Keyed on hash
 * ALONE, the feed line would then bill the whole document's history, not this run's extract
 * step, and the number would double on the first retry. The fix bounds the query to the run's
 * own start time; these tests pin that bound.
 */

const USER = "00000000-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

interface Row {
  user_id: string;
  input_hash: string;
  cost_usd: number | null;
  created_at: string; // ISO 8601, UTC — lexicographically comparable, which is how `.gte` sees it.
}

type Result = { data: Array<{ cost_usd: number | null }>; error: null };

/**
 * A Supabase query stub that actually HONORS `.eq`/`.gte` against an in-memory table.
 *
 * That is the whole point: because the stub applies exactly the filters the code asks for and
 * no others, dropping the `created_at` bound in `extractionCost` becomes observable — the
 * prior-run rows stop being excluded and the sum inflates. A stub that ignored filters would
 * pass whether or not the bound was there, i.e. a guard that cannot fire.
 */
function fakeAdmin(rows: readonly Row[]): SupabaseAdminClient {
  const build = (predicates: ReadonlyArray<(row: Row) => boolean>) => {
    const result = (): Result => ({
      data: rows
        .filter((row) => predicates.every((p) => p(row)))
        .map((row) => ({
          cost_usd: row.cost_usd,
        })),
      error: null,
    });
    const builder = {
      select: () => builder,
      eq: (column: keyof Row, value: unknown) =>
        build([...predicates, (row) => row[column] === value]),
      gte: (column: keyof Row, value: string) =>
        build([...predicates, (row) => String(row[column]) >= value]),
      // biome-ignore lint/suspicious/noThenProperty: the stub mimics Supabase's thenable query builder — `await query` is exactly how the real client resolves.
      then: (onFulfilled: (value: Result) => unknown) =>
        Promise.resolve(result()).then(onFulfilled),
    };
    return builder;
  };
  return { from: () => build([]) } as unknown as SupabaseAdminClient;
}

const startedAt = new Date("2026-07-21T12:00:00.000Z").getTime();
const during = (secondsAfter: number) => new Date(startedAt + secondsAfter * 1000).toISOString();
const earlier = (secondsBefore: number) => new Date(startedAt - secondsBefore * 1000).toISOString();

describe("extractionCost is scoped to this run's extract step", () => {
  it("sums every ladder rung of THIS run", async () => {
    const admin = fakeAdmin([
      { user_id: USER, input_hash: HASH, cost_usd: 0.11, created_at: during(5) },
      { user_id: USER, input_hash: HASH, cost_usd: 0.02, created_at: during(9) }, // a corrective rung
    ]);

    await expect(extractionCost(admin, USER, HASH, startedAt)).resolves.toBeCloseTo(0.13, 10);
  });

  /**
   * 🔴 RED against the real broken input. A document reprocessed (or an Inngest step retried
   * after a successful generateObject) leaves the PRIOR run's priced rows in the table under
   * the identical `input_hash`. Only this run's rows may be billed to this run's feed line.
   *
   * RED by mutation: delete the `.gte("created_at", …)` bound in `extractionCost` and the
   * prior-run rows are summed in too — this expects 0.15 but gets 0.35.
   */
  it("🔴 excludes an earlier run's rows that share the same input_hash", async () => {
    const admin = fakeAdmin([
      // Earlier run of the SAME document: same hash, logged before this run began.
      { user_id: USER, input_hash: HASH, cost_usd: 0.13, created_at: earlier(90) },
      { user_id: USER, input_hash: HASH, cost_usd: 0.07, created_at: earlier(60) },
      // This run.
      { user_id: USER, input_hash: HASH, cost_usd: 0.13, created_at: during(6) },
      { user_id: USER, input_hash: HASH, cost_usd: 0.02, created_at: during(11) },
    ]);

    // This run alone is 0.15; the whole history is 0.35.
    await expect(extractionCost(admin, USER, HASH, startedAt)).resolves.toBeCloseTo(0.15, 10);
  });

  it("does not cross into another user or another call's hash", async () => {
    const admin = fakeAdmin([
      { user_id: USER, input_hash: HASH, cost_usd: 0.1, created_at: during(5) },
      // Another user's identical-hash row, and this user's other-job row in the same window.
      { user_id: "someone-else", input_hash: HASH, cost_usd: 9.99, created_at: during(5) },
      { user_id: USER, input_hash: OTHER_HASH, cost_usd: 9.99, created_at: during(5) },
    ]);

    await expect(extractionCost(admin, USER, HASH, startedAt)).resolves.toBeCloseTo(0.1, 10);
  });

  it("returns null — not $0.00 — when every matching row is unpriced", async () => {
    const admin = fakeAdmin([
      { user_id: USER, input_hash: HASH, cost_usd: null, created_at: during(5) },
    ]);

    await expect(extractionCost(admin, USER, HASH, startedAt)).resolves.toBeNull();
  });

  it("returns null when the run wrote no rows at all", async () => {
    await expect(extractionCost(fakeAdmin([]), USER, HASH, startedAt)).resolves.toBeNull();
  });
});
