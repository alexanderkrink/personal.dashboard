import type { SupabaseAdminClient } from "@study/db";
import { describe, expect, it, vi } from "vitest";
import { createCachedSpendReader, monthStartInAppTimezone, readMonthToDateSpendUsd } from "./spend";

/**
 * A stub of the one PostgREST chain `readMonthToDateSpendUsd` uses. Typed loosely at the
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

describe("readMonthToDateSpendUsd", () => {
  it("coerces PostgREST's numeric-as-string, rather than concatenating it", async () => {
    // ⚠ This is the shape the live project actually returns: `numeric` serializes as a
    // JSON STRING, while the generated Database type claims `number`. Summing those
    // naively yields "01.230.45" — a spend figure that is never over budget because it is
    // not a number at all. Wave 2 lost a day to the identical class of bug on timestamps.
    const { client } = stubClient({
      data: [{ cost_usd: "1.23000000" }, { cost_usd: "0.45000000" }],
    });
    await expect(readMonthToDateSpendUsd(client, "user-1")).resolves.toBeCloseTo(1.68, 10);
  });

  it("treats a NULL day-total as zero", async () => {
    const { client } = stubClient({ data: [{ cost_usd: null }, { cost_usd: "2.00000000" }] });
    await expect(readMonthToDateSpendUsd(client, "user-1")).resolves.toBeCloseTo(2, 10);
  });

  it("is zero when nothing has been spent this month", async () => {
    const { client } = stubClient({ data: [] });
    await expect(readMonthToDateSpendUsd(client, "user-1")).resolves.toBe(0);
  });

  it("filters to the user and to this month", async () => {
    const { client, from, eq, gte } = stubClient({ data: [] });
    await readMonthToDateSpendUsd(client, "user-1", new Date("2026-07-19T10:00:00Z"));
    expect(from).toHaveBeenCalledWith("ai_daily_cost");
    expect(eq).toHaveBeenCalledWith("user_id", "user-1");
    expect(gte).toHaveBeenCalledWith("day", "2026-07-01");
  });

  it("throws rather than silently reporting $0 when the rollup cannot be read", async () => {
    // A failed read that returned 0 would look exactly like "under budget" — the guard
    // would wave through every call at the moment it is least able to know better.
    const { client } = stubClient({ error: { message: "connection reset" } });
    await expect(readMonthToDateSpendUsd(client, "user-1")).rejects.toThrow(/connection reset/);
  });
});

describe("createCachedSpendReader", () => {
  it("queries once inside the TTL and again after it", async () => {
    const { client, gte } = stubClient({ data: [{ cost_usd: "5.00000000" }] });
    let clock = 1_000;
    const read = createCachedSpendReader(client, "user-1", {
      ttlMs: 30_000,
      now: () => clock,
    });

    await expect(read()).resolves.toBe(5);
    await expect(read()).resolves.toBe(5);
    expect(gte).toHaveBeenCalledTimes(1);

    clock += 30_001;
    await expect(read()).resolves.toBe(5);
    expect(gte).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent reads into one query", async () => {
    // A pipeline step that fans out ten calls at once should not make ten identical
    // round trips before any of them has populated the cache.
    const { client, gte } = stubClient({ data: [{ cost_usd: "3.00000000" }] });
    const read = createCachedSpendReader(client, "user-1");

    const results = await Promise.all(Array.from({ length: 10 }, () => read()));

    expect(results).toEqual(Array.from({ length: 10 }, () => 3));
    expect(gte).toHaveBeenCalledTimes(1);
  });
});
