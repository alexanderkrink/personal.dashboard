import type { SupabaseAdminClient } from "@study/db";
import { describe, expect, it, vi } from "vitest";
import { createCachedSpendReader, monthStartInAppTimezone, readMonthToDateSpend } from "./spend";

/**
 * A stub of the one PostgREST chain `readMonthToDateSpend` uses. Typed loosely at the
 * seam and cast once, rather than `any` at every step — Biome errors on `any`.
 */
function stubClient(result: { data?: unknown[]; error?: { message: string } }) {
  const gte = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null });
  const eq = vi.fn(() => ({ gte }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { client: { from } as unknown as SupabaseAdminClient, from, select, eq, gte };
}

describe("monthStartInAppTimezone", () => {
  it("uses the Madrid month, not the UTC one", () => {
    // 2026-08-01T00:30 Madrid is 2026-07-31T22:30 UTC. Computing the boundary in UTC
    // would bill the first 90 minutes of August against July's budget.
    expect(monthStartInAppTimezone(new Date("2026-07-31T22:30:00Z"))).toBe("2026-08-01");
    // ...and the same instant one minute earlier in Madrid is still July.
    expect(monthStartInAppTimezone(new Date("2026-07-31T21:30:00Z"))).toBe("2026-07-01");
  });

  it("pads to a valid ISO date across the year boundary", () => {
    expect(monthStartInAppTimezone(new Date("2027-01-01T00:00:00Z"))).toBe("2027-01-01");
  });
});

describe("readMonthToDateSpend", () => {
  it("sums the numbers PostgREST actually returns", async () => {
    // ⚠ MEASURED against the linked project on 2026-07-19: PostgREST returns this
    // `numeric` column as a JSON number, so the generated `number` type is honest and
    // this is the ordinary path. (The Supabase SQL editor renders the same value as
    // "0.00005625" — a difference in that tool's encoding, not in the column.)
    const { client } = stubClient({
      data: [
        { cost_usd: 1.23, unpriced_calls: 0 },
        { cost_usd: 0.45, unpriced_calls: 0 },
      ],
    });
    await expect(readMonthToDateSpend(client, "user-1")).resolves.toEqual({
      costUsd: expect.closeTo(1.68, 10),
      unpricedCalls: 0,
    });
  });

  it("still survives a string, because numeric is one wire-format change from being one", async () => {
    // The coercion is not decoration. Without it, `sum + row` concatenates and yields
    // "01.230.45" — a spend figure that is never over budget because it is not a number
    // at all, so the cap would silently stop existing. Wave 2 lost a day to the identical
    // class of bug on timestamps.
    const { client } = stubClient({
      data: [
        { cost_usd: "1.23000000", unpriced_calls: 0 },
        { cost_usd: "0.45000000", unpriced_calls: 0 },
      ],
    });
    await expect(readMonthToDateSpend(client, "user-1")).resolves.toEqual({
      costUsd: expect.closeTo(1.68, 10),
      unpricedCalls: 0,
    });
  });

  it("carries the unpriced count out alongside a NULL day-total, instead of dropping it", async () => {
    // THE HOLE (#4). The all-unpriced group arrives as `cost_usd: null` — the view's
    // coalesce makes it 0 — and the old reader returned just `2`, so a caller could not
    // tell "three calls we couldn't price" from "three calls that were free". The count
    // is the only part of that group that carries information, and it used to be the
    // part that was thrown away.
    const { client } = stubClient({
      data: [
        { cost_usd: null, unpriced_calls: 3 },
        { cost_usd: "2.00000000", unpriced_calls: 0 },
      ],
    });
    await expect(readMonthToDateSpend(client, "user-1")).resolves.toEqual({
      costUsd: expect.closeTo(2, 10),
      unpricedCalls: 3,
    });
  });

  it("is zero when nothing has been spent this month", async () => {
    const { client } = stubClient({ data: [] });
    await expect(readMonthToDateSpend(client, "user-1")).resolves.toEqual({
      costUsd: 0,
      unpricedCalls: 0,
    });
  });

  it("filters to the user and to this month", async () => {
    const { client, from, eq, gte } = stubClient({ data: [] });
    await readMonthToDateSpend(client, "user-1", new Date("2026-07-19T10:00:00Z"));
    expect(from).toHaveBeenCalledWith("ai_daily_cost");
    expect(eq).toHaveBeenCalledWith("user_id", "user-1");
    expect(gte).toHaveBeenCalledWith("day", "2026-07-01");
  });

  it("throws rather than silently reporting $0 when the rollup cannot be read", async () => {
    // A failed read that returned 0 would look exactly like "under budget" — the guard
    // would wave through every call at the moment it is least able to know better.
    const { client } = stubClient({ error: { message: "connection reset" } });
    await expect(readMonthToDateSpend(client, "user-1")).rejects.toThrow(/connection reset/);
  });
});

describe("createCachedSpendReader", () => {
  it("queries once inside the TTL and again after it", async () => {
    const { client, gte } = stubClient({ data: [{ cost_usd: "5.00000000", unpriced_calls: 0 }] });
    let clock = 1_000;
    const read = createCachedSpendReader(client, "user-1", {
      ttlMs: 30_000,
      now: () => clock,
    });

    await expect(read()).resolves.toEqual({ costUsd: 5, unpricedCalls: 0 });
    await expect(read()).resolves.toEqual({ costUsd: 5, unpricedCalls: 0 });
    expect(gte).toHaveBeenCalledTimes(1);

    clock += 30_001;
    await expect(read()).resolves.toEqual({ costUsd: 5, unpricedCalls: 0 });
    expect(gte).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent reads into one query", async () => {
    // A pipeline step that fans out ten calls at once should not make ten identical
    // round trips before any of them has populated the cache.
    const { client, gte } = stubClient({ data: [{ cost_usd: "3.00000000", unpriced_calls: 0 }] });
    const read = createCachedSpendReader(client, "user-1");

    const results = await Promise.all(Array.from({ length: 10 }, () => read()));

    expect(results).toEqual(Array.from({ length: 10 }, () => ({ costUsd: 3, unpricedCalls: 0 })));
    expect(gte).toHaveBeenCalledTimes(1);
  });
});
