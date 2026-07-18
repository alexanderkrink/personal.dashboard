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
  const item = (over: Partial<Parameters<typeof planTombstones>[0][number]> = {}) => ({
    id: "item-1",
    ics_uid: "uid-1",
    feed_id: "feed-1",
    missing_since: null,
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
