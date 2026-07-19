import { describe, expect, it } from "vitest";
import {
  formatRetryAfter,
  isManualSyncRateLimited,
  rateLimitRemainingMs,
  STALE_AFTER_MS,
  selectStaleFeeds,
} from "./staleness";

const NOW = new Date("2026-09-15T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

describe("selectStaleFeeds", () => {
  it("selects feeds last synced more than 30 minutes ago", () => {
    expect(
      selectStaleFeeds(
        [
          { id: "fresh", active: true, last_synced_at: minutesAgo(12) },
          { id: "stale", active: true, last_synced_at: minutesAgo(45) },
        ],
        NOW,
      ),
    ).toEqual(["stale"]);
  });

  it("treats a never-synced feed as stale", () => {
    // The moment the user has just added a feed and is waiting for it to fill.
    expect(selectStaleFeeds([{ id: "new", active: true, last_synced_at: null }], NOW)).toEqual([
      "new",
    ]);
  });

  it("never selects a paused feed", () => {
    expect(selectStaleFeeds([{ id: "paused", active: false, last_synced_at: null }], NOW)).toEqual(
      [],
    );
  });

  it("treats exactly 30 minutes as stale", () => {
    const at = new Date(NOW.getTime() - STALE_AFTER_MS).toISOString();
    expect(selectStaleFeeds([{ id: "edge", active: true, last_synced_at: at }], NOW)).toEqual([
      "edge",
    ]);
  });

  /**
   * 🚨 The reason this module keys on the clock. All three HTTP skip layers are
   * unreliable on the IE feed — no ETag, a `Last-Modified` of *now*, and a body
   * that is byte-unstable because DTSTAMP is re-stamped every regeneration — so
   * a sync of it essentially never reports `unchanged`.
   *
   * Staleness must therefore be decided by `last_synced_at` alone. A feed that
   * just ran and reported a full 374-row rewrite is still FRESH.
   */
  it("is decided by the clock, not by whether the last sync reported changes", () => {
    expect(
      selectStaleFeeds(
        [{ id: "just-rewrote-everything", active: true, last_synced_at: minutesAgo(1) }],
        NOW,
      ),
    ).toEqual([]);
  });
});

describe("manual sync rate limit", () => {
  it("refuses a second manual sync inside the same minute", () => {
    expect(isManualSyncRateLimited(minutesAgo(0.25), NOW)).toBe(true);
    expect(rateLimitRemainingMs(minutesAgo(0.25), NOW)).toBe(45_000);
  });

  it("allows one a minute later", () => {
    expect(isManualSyncRateLimited(minutesAgo(1), NOW)).toBe(false);
    expect(rateLimitRemainingMs(minutesAgo(1), NOW)).toBe(0);
  });

  it("allows the very first sync of a new feed", () => {
    expect(isManualSyncRateLimited(null, NOW)).toBe(false);
  });

  it("does not lock a feed out on an unparseable timestamp", () => {
    expect(isManualSyncRateLimited("not a date", NOW)).toBe(false);
  });

  it("rounds the wait up, so it never reads as 0s", () => {
    expect(formatRetryAfter(45_000)).toBe("45s");
    expect(formatRetryAfter(1)).toBe("1s");
    expect(formatRetryAfter(45_400)).toBe("46s");
  });
});
