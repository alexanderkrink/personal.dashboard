import { describe, expect, it } from "vitest";
import {
  applyLocks,
  isCancelledOccurrenceVisible,
  isLockableItemField,
  isTombstoneVisible,
  occurrenceFingerprint,
  planOrphanedOccurrences,
  planTombstones,
  withLockedField,
} from "./diff";

const NOW = "2026-09-10T12:00:00.000Z";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();

describe("applyLocks", () => {
  it("drops locked keys and keeps the rest", () => {
    const result = applyLocks({ title: "Feed title", kind: "class", sequence: 2 }, ["title"]);
    expect(result).toEqual({ kind: "class", sequence: 2 });
  });

  it("returns the payload untouched when nothing is locked", () => {
    const payload = { title: "x" };
    expect(applyLocks(payload, [])).toBe(payload);
  });

  it("ignores a lock name that no longer matches a column", () => {
    // user_locked_fields is plain text[]; a name left over from an older schema
    // must not break a sync.
    expect(applyLocks({ title: "x" }, ["nonexistent_column"])).toEqual({ title: "x" });
  });

  it("can lock every field, producing a no-op update", () => {
    expect(applyLocks({ title: "x", kind: "class" }, ["title", "kind"])).toEqual({});
  });
});

describe("withLockedField", () => {
  it("adds without duplicating and keeps a stable order", () => {
    expect(withLockedField(["title"], "course_id")).toEqual(["course_id", "title"]);
    expect(withLockedField(["title"], "title")).toEqual(["title"]);
  });
});

describe("isLockableItemField", () => {
  it("accepts real columns and rejects anything else", () => {
    expect(isLockableItemField("title")).toBe(true);
    expect(isLockableItemField("weight_override")).toBe(true);
    // A typo must not create a lock that silently protects nothing.
    expect(isLockableItemField("titel")).toBe(false);
    expect(isLockableItemField("user_id")).toBe(false);
    expect(isLockableItemField("completed_at")).toBe(false);
  });
});

describe("occurrenceFingerprint", () => {
  const base = {
    starts_at: "2026-09-10T08:00:00.000Z",
    ends_at: "2026-09-10T09:30:00.000Z",
    all_day: false,
    status: "confirmed" as const,
    overridden: false,
  };

  it("is equal for equal payloads", () => {
    expect(occurrenceFingerprint(base)).toBe(occurrenceFingerprint({ ...base }));
  });

  it("changes when any synced field changes", () => {
    expect(occurrenceFingerprint({ ...base, status: "cancelled" })).not.toBe(
      occurrenceFingerprint(base),
    );
    expect(occurrenceFingerprint({ ...base, ends_at: null })).not.toBe(occurrenceFingerprint(base));
  });

  it("does not confuse a null end with an empty-string one", () => {
    expect(occurrenceFingerprint({ ...base, ends_at: null })).not.toBe(
      occurrenceFingerprint({ ...base, ends_at: "" }),
    );
  });
});

describe("planTombstones", () => {
  // Defaults to a FUTURE occurrence, so the classic lifecycle cases below read as
  // they always did. A past date is the interesting input and is always explicit.
  const item = (over: Partial<Parameters<typeof planTombstones>[0][number]> = {}) => ({
    id: "item-1",
    ics_uid: "uid-1",
    feed_id: "feed-1",
    missing_since: null,
    latestOccurrenceStartsAt: "2026-12-01T09:00:00.000Z",
    hasGradedHistory: false,
    ...over,
  });

  it("marks a newly absent item", () => {
    expect(planTombstones([item()], new Set(), NOW)).toEqual([
      { action: "mark", id: "item-1", missingSince: NOW },
    ]);
  });

  it("clears a tombstone when the UID reappears", () => {
    expect(
      planTombstones([item({ missing_since: ago(2 * DAY) })], new Set(["uid-1"]), NOW),
    ).toEqual([{ action: "clear", id: "item-1" }]);
  });

  it("does nothing to an item that was never tombstoned and is still present", () => {
    expect(planTombstones([item()], new Set(["uid-1"]), NOW)).toEqual([]);
  });

  it("keeps the ORIGINAL missing_since rather than resetting the clock", () => {
    const since = ago(3 * DAY);
    expect(planTombstones([item({ missing_since: since })], new Set(), NOW)).toEqual([
      { action: "keep", id: "item-1", missingSince: since },
    ]);
  });

  it("deletes at exactly seven days, not before", () => {
    const justUnder = planTombstones(
      [item({ missing_since: ago(7 * DAY - 1000) })],
      new Set(),
      NOW,
    );
    expect(justUnder[0]?.action).toBe("keep");

    const exactly = planTombstones([item({ missing_since: ago(7 * DAY) })], new Set(), NOW);
    expect(exactly[0]?.action).toBe("delete");
  });

  it("never touches a manual item", () => {
    expect(planTombstones([item({ feed_id: null })], new Set(), NOW)).toEqual([]);
  });

  /* -- 🔴 feed-window roll-off must not be read as cancellation ------------ */

  it("retains a vanished PAST item instead of starting the clock", () => {
    expect(
      planTombstones(
        [item({ latestOccurrenceStartsAt: "2026-01-19T08:30:00.000Z" })],
        new Set(),
        NOW,
      ),
    ).toEqual([
      { action: "retain", reason: "feed-window-rolloff", id: "item-1", clearMissingSince: false },
    ]);
  });

  it("never deletes a past item, however long it has been absent", () => {
    // A year of absence. Under the old rule this was a delete on day seven.
    //
    // The occurrence predates the mark, which is what makes this a roll-off: the
    // session had already happened when the feed stopped carrying it. That is also
    // why the mark is cleared — see the resurrection test below for the mirror case.
    const result = planTombstones(
      [
        item({
          latestOccurrenceStartsAt: "2024-06-01T08:30:00.000Z",
          missing_since: ago(365 * DAY),
        }),
      ],
      new Set(),
      NOW,
    );
    expect(result).toEqual([
      { action: "retain", reason: "feed-window-rolloff", id: "item-1", clearMissingSince: true },
    ]);
  });

  /* -- 🔴 a cancellation must survive its own date passing ----------------- */

  it("keeps the tombstone on an event cancelled BEFORE it was due", () => {
    // Marked while still upcoming (2026-09-01) for a session on 2026-09-05, and
    // read after that date has passed. Clearing the mark here would put a lecture
    // that never happened back on the calendar — and, because every later sync
    // takes the same branch, would make it undeletable forever.
    expect(
      planTombstones(
        [
          item({
            latestOccurrenceStartsAt: "2026-09-05T09:00:00.000Z",
            missing_since: "2026-09-01T06:00:00.000Z",
          }),
        ],
        new Set(),
        NOW,
      ),
    ).toEqual([
      { action: "retain", reason: "feed-window-rolloff", id: "item-1", clearMissingSince: false },
    ]);
  });

  it("still clears a mark made AFTER the session had already happened", () => {
    // The live shape: session 2026-01-19, marked 2026-07-19 when the window rolled.
    expect(
      planTombstones(
        [
          item({
            latestOccurrenceStartsAt: "2026-01-19T08:30:00.000Z",
            missing_since: "2026-07-19T00:00:40.410Z",
          }),
        ],
        new Set(),
        NOW,
      ),
    ).toEqual([
      { action: "retain", reason: "feed-window-rolloff", id: "item-1", clearMissingSince: true },
    ]);
  });

  it("retains an item with no occurrences rather than deleting it", () => {
    // No date is no evidence. Deletion requires positive evidence of future-ness,
    // so the destructive path must not be the one that fires on broken data.
    expect(
      planTombstones(
        [item({ latestOccurrenceStartsAt: null, missing_since: ago(30 * DAY) })],
        new Set(),
        NOW,
      ),
    ).toEqual([
      { action: "retain", reason: "feed-window-rolloff", id: "item-1", clearMissingSince: true },
    ]);
  });

  it("dates a recurring item by its LAST occurrence, not its first", () => {
    // A weekly lecture that started in January is still live in September. Dating
    // it by the earliest occurrence would put a whole term of classes on the timer.
    expect(
      planTombstones(
        [item({ latestOccurrenceStartsAt: "2026-12-15T08:30:00.000Z" })],
        new Set(),
        NOW,
      ),
    ).toEqual([{ action: "mark", id: "item-1", missingSince: NOW }]);
  });

  it("still tombstones and deletes a FUTURE item — cancellation is not broken", () => {
    // The fix narrows the deletion path; it must not close it. A future event that
    // vanishes IS a cancellation, and §3.6 still depends on that.
    const future = item({
      latestOccurrenceStartsAt: "2026-12-01T09:00:00.000Z",
      missing_since: ago(7 * DAY),
    });
    expect(planTombstones([future], new Set(), NOW)).toEqual([{ action: "delete", id: "item-1" }]);
  });

  /* -- 🔴 §6.3: graded history is retained at ANY-occurrence granularity ---- */

  it("retains a mixed past+future item that carries graded history, instead of marking it", () => {
    // The LATEST occurrence is in the future, so isFeedWindowRolloff does NOT
    // fire — this is the mid-term wholesale-removal case the latest-occurrence
    // guard misses. Any attendance/participation on any occurrence must still
    // retain it, or the sweep deletes it and 23503s on the NO ACTION ledger FK.
    // It is hidden via the ordinary missing_since path, so the mark is set here.
    expect(planTombstones([item({ hasGradedHistory: true })], new Set(), NOW)).toEqual([
      { action: "retain", reason: "graded-history", id: "item-1", markMissingSince: NOW },
    ]);
  });

  it("marks the SAME future item when it has no graded history — the signal is what flips it", () => {
    // The mirror of the case above with only `hasGradedHistory` changed, proving
    // the retain is driven by the ledger signal and not by anything else.
    expect(planTombstones([item({ hasGradedHistory: false })], new Set(), NOW)).toEqual([
      { action: "mark", id: "item-1", missingSince: NOW },
    ]);
  });

  it("keeps an existing mark on a graded item rather than resetting the 24-hour hide", () => {
    // markMissingSince is null when a mark already exists: the item is already
    // hidden, and rewriting missing_since every sync would re-date the 24-hour
    // hide forever — the same discipline `keep` uses for the delete clock.
    expect(
      planTombstones(
        [item({ hasGradedHistory: true, missing_since: ago(3 * DAY) })],
        new Set(),
        NOW,
      ),
    ).toEqual([
      { action: "retain", reason: "graded-history", id: "item-1", markMissingSince: null },
    ]);
  });

  it("routes a PAST graded item through the roll-off branch, which keeps it visible", () => {
    // Past + graded is a window roll-off of history, retained EITHER way — but via
    // feed-window-rolloff, which clears the wrong mark and keeps it in VIEW, not
    // graded-history, which hides it. Only a mid-term removal (future sessions
    // still pending) hides. The rolloff branch is checked first, so it wins here.
    expect(
      planTombstones(
        [
          item({
            hasGradedHistory: true,
            latestOccurrenceStartsAt: "2026-01-19T08:30:00.000Z",
            missing_since: "2026-07-19T00:00:40.410Z",
          }),
        ],
        new Set(),
        NOW,
      ),
    ).toEqual([
      { action: "retain", reason: "feed-window-rolloff", id: "item-1", clearMissingSince: true },
    ]);
  });

  /**
   * The exact shape found on the live database, 2026-07-19.
   *
   * 5 items sharing one `missing_since`, every one starting 2026-01-19, while the
   * feed's `earliest_live` had moved to 2026-01-21. Nothing was cancelled: the
   * rolling window slid forward and the oldest day fell off the end. All 5 were
   * seven days from a hard delete (due 2026-07-26), and 220 of the 374 live
   * occurrences were in the past and on the same timer.
   */
  it("does not delete the 5 real roll-off rows the live feed produced", () => {
    const missingSince = "2026-07-19T00:00:40.410Z";
    const rows = [
      { id: "637bd828", uid: "F154208PLANI3184776P3606C166056S382837A487469", at: "08:30" },
      { id: "d88e5cf8", uid: "F176752PLANI3184139P3606C166056S382497A488728", at: "10:00" },
      { id: "29bb991e", uid: "F176995PLANI3192590P2726C166596S399118A510053", at: "14:00" },
      { id: "a5b9f985", uid: "F154527PLANI3114735P3032C166597S399996A511151", at: "17:00" },
      { id: "cf20071e", uid: "F175441PLANI3099413P4069C164931S389256A492562", at: "23:00" },
    ].map((row) => ({
      id: row.id,
      ics_uid: row.uid,
      feed_id: "d085e882-1a23-4007-a2d3-54e59f73dfa6",
      missing_since: missingSince,
      // PostgREST's spelling, on purpose: the planner must not depend on the
      // parser's `.000Z` form to recognise a date as past.
      latestOccurrenceStartsAt: `2026-01-19T${row.at}:00+00:00`,
      hasGradedHistory: false,
    }));

    // Eight days after the mark — one day past the old 7-day deadline.
    const actions = planTombstones(rows, new Set(), "2026-07-27T00:00:00.000Z");

    expect(actions.every((action) => action.action === "retain")).toBe(true);
    expect(actions.some((action) => action.action === "delete")).toBe(false);
    // Every one also has its wrongly-set tombstone cleared, so they come back into
    // view instead of staying hidden by the 24-hour rule.
    expect(actions).toEqual(
      rows.map((row) => ({
        action: "retain",
        reason: "feed-window-rolloff",
        id: row.id,
        clearMissingSince: true,
      })),
    );
  });
});

describe("isTombstoneVisible", () => {
  it("shows an item that is not missing", () => {
    expect(isTombstoneVisible(null, NOW)).toBe(true);
  });

  it("hides at 24 hours, not before", () => {
    expect(isTombstoneVisible(ago(23 * HOUR), NOW)).toBe(true);
    expect(isTombstoneVisible(ago(24 * HOUR), NOW)).toBe(false);
  });
});

describe("isCancelledOccurrenceVisible", () => {
  it("keeps a cancellation visible for seven days, then hides it", () => {
    // A cancelled lecture is information — a silent gap is not the same message.
    expect(isCancelledOccurrenceVisible(ago(6 * DAY), NOW)).toBe(true);
    expect(isCancelledOccurrenceVisible(ago(7 * DAY), NOW)).toBe(false);
  });
});

describe("planOrphanedOccurrences", () => {
  const stored = [
    { id: "a", recurrence_id: "r1", status: "confirmed" },
    { id: "b", recurrence_id: "r2", status: "confirmed" },
    { id: "c", recurrence_id: "r3", status: "cancelled" },
  ];

  it("returns instances the snapshot no longer expands", () => {
    expect(
      planOrphanedOccurrences(stored, [
        {
          recurrenceId: "r1",
          startsAtUtc: NOW,
          allDay: false,
          status: "confirmed",
          overridden: false,
        },
      ]),
    ).toEqual(["b"]);
  });

  it("skips one already cancelled, so updated_at is not reset every sync", () => {
    // updated_at is what dates the strike-through (§3.6). Re-cancelling would
    // make a week-old cancellation look brand new on every run.
    expect(planOrphanedOccurrences(stored, [])).toEqual(["a", "b"]);
  });
});
