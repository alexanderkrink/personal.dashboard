import type { CalendarProvider, NormalizedEvent } from "@study/core";
import { ok } from "@study/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The engine's behavioural tests.
 *
 * The provider is mocked, not the store: what is under test is everything the
 * engine decides — locks, tombstones, cancellations, idempotence — and all of
 * that is downstream of "here are the events the feed returned".
 */
const events = vi.hoisted(() => ({ current: [] as NormalizedEvent[] }));
const changed = vi.hoisted(() => ({ current: true }));

vi.mock("./providers", () => ({
  providerFor: (): CalendarProvider =>
    ({
      source: "ics",
      configSchema: { safeParse: () => ({ success: true, data: {} }) },
      sync: async () =>
        ok(
          changed.current
            ? { changed: true, cursor: { contentHash: "hash" }, events: events.current }
            : { changed: false, cursor: { contentHash: "hash" } },
        ),
    }) as unknown as CalendarProvider,
}));

const { createMemoryStore } = await import("./test-store");
const { syncFeed } = await import("./sync");

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function lecture(
  uid: string,
  startsAtUtc: string,
  title = "ALGORITHMS & DATA STRUCTURES",
): NormalizedEvent {
  return {
    uid,
    sequence: 0,
    kind: "class",
    title,
    rawSummary: `${title}   (Ses. 4) T-03.01`,
    courseHint: title,
    sessionFrom: 4,
    sessionTo: 4,
    descriptor: "regular",
    occurrences: [
      {
        recurrenceId: "",
        startsAtUtc,
        endsAtUtc: new Date(Date.parse(startsAtUtc) + 90 * 60_000).toISOString(),
        allDay: false,
        status: "confirmed",
        overridden: false,
      },
    ],
  };
}

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-09-01T08:00:00.000Z");
const at = (days: number) => new Date(T0.getTime() + days * DAY);

beforeEach(() => {
  events.current = [];
  changed.current = true;
});

/* -------------------------------------------------------------------------- */
/* THE tombstone round trip                                                   */
/* -------------------------------------------------------------------------- */

describe("tombstones — the drop-and-restore round trip (§3.3)", () => {
  it("keeps course_id, completed_at and row identity across the grace window", async () => {
    const { store, state } = createMemoryStore({
      context: {
        timezone: "Europe/Madrid",
        courses: [
          { id: "course-1", code: null, title: "ALGORITHMS & DATA STRUCTURES", total_sessions: 30 },
        ],
        matchers: [],
        assessments: [],
        semesters: [],
      },
    });

    // Day 0 — the event is in the feed and syncs normally.
    events.current = [lecture("uid-A", "2026-09-10T08:00:00.000Z")];
    await syncFeed(store, "feed-1", at(0));

    const original = state.items.find((item) => item.ics_uid === "uid-A");
    expect(original).toBeDefined();
    if (!original) throw new Error("unreachable");
    const originalId = original.id;
    expect(original.course_id).toBe("course-1");

    // The user checks the session off. This is THE thing that must survive:
    // it is their record, not the feed's.
    const occurrence = state.occurrences.find((entry) => entry.item_id === originalId);
    expect(occurrence).toBeDefined();
    if (!occurrence) throw new Error("unreachable");
    occurrence.completed_at = "2026-09-10T09:30:00.000Z";

    // Day 1 — the professor cancels. The IE feed has no STATUS:CANCELLED, so
    // the event does not say it was cancelled; it simply is not there.
    events.current = [];
    const dropped = await syncFeed(store, "feed-1", at(1));
    expect(dropped).toMatchObject({ status: "ok", tombstoned: 1 });

    const tombstoned = state.items.find((item) => item.id === originalId);
    expect(tombstoned?.missing_since).toBe(at(1).toISOString());
    // Tombstoned is NOT deleted. The row, the course link and the completion
    // are all still there.
    expect(tombstoned?.course_id).toBe("course-1");
    expect(state.occurrences.find((entry) => entry.item_id === originalId)?.completed_at).toBe(
      "2026-09-10T09:30:00.000Z",
    );

    // Day 3 — still absent, still inside the 7-day window. Nothing happens, and
    // crucially missing_since is NOT reset, or the deadline would never arrive.
    await syncFeed(store, "feed-1", at(3));
    expect(state.items.find((item) => item.id === originalId)?.missing_since).toBe(
      at(1).toISOString(),
    );

    // Day 5 — the feed regenerates and the event is back. This is the whole
    // point of the grace period.
    events.current = [lecture("uid-A", "2026-09-10T08:00:00.000Z")];
    const restored = await syncFeed(store, "feed-1", at(5));
    expect(restored).toMatchObject({ status: "ok" });

    const revived = state.items.find((item) => item.ics_uid === "uid-A");
    expect(revived).toBeDefined();
    if (!revived) throw new Error("unreachable");

    // IDENTITY: the same row, not a re-created one.
    expect(revived.id).toBe(originalId);
    // The tombstone is cleared.
    expect(revived.missing_since).toBeNull();
    // The course link survived.
    expect(revived.course_id).toBe("course-1");
    // And the user's completion survived, because the occurrence was never
    // deleted and completed_at is not a column sync writes.
    expect(state.occurrences.find((entry) => entry.item_id === originalId)?.completed_at).toBe(
      "2026-09-10T09:30:00.000Z",
    );
    expect(state.items).toHaveLength(1);
  });

  it("deletes only after seven CONTINUOUS days of absence", async () => {
    const { store, state } = createMemoryStore();

    events.current = [lecture("uid-B", "2026-09-10T08:00:00.000Z")];
    await syncFeed(store, "feed-1", at(0));
    const itemId = state.items[0]?.id;
    expect(itemId).toBeDefined();

    events.current = [];
    await syncFeed(store, "feed-1", at(1)); // marked missing
    await syncFeed(store, "feed-1", at(6)); // still inside the window
    expect(state.items).toHaveLength(1);

    // Day 8 — that is seven days since day 1, so it goes.
    const swept = await syncFeed(store, "feed-1", at(8));
    expect(swept).toMatchObject({ deleted: 1 });
    expect(state.items).toHaveLength(0);
  });

  it("restarts the clock when an item reappears, so a flapping feed never deletes", async () => {
    const { store, state } = createMemoryStore();

    events.current = [lecture("uid-C", "2026-09-10T08:00:00.000Z")];
    await syncFeed(store, "feed-1", at(0));

    // Absent for six days, back for one, absent again for six. Continuous
    // absence never reaches seven, so the row must survive — a truncated feed
    // generation is exactly this shape.
    events.current = [];
    await syncFeed(store, "feed-1", at(1));
    await syncFeed(store, "feed-1", at(6));
    events.current = [lecture("uid-C", "2026-09-10T08:00:00.000Z")];
    await syncFeed(store, "feed-1", at(7));
    expect(state.items[0]?.missing_since).toBeNull();

    events.current = [];
    await syncFeed(store, "feed-1", at(8));
    await syncFeed(store, "feed-1", at(13));
    expect(state.items).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Manual items                                                               */
/* -------------------------------------------------------------------------- */

describe("manual items are never touched by sync (§3.3)", () => {
  it("survives a sync whose snapshot contains none of them", async () => {
    const { store, state } = createMemoryStore();

    // A quick-add item: feed_id null, and therefore in NO feed's snapshot.
    state.items.push({
      id: "manual-1",
      user_id: "user-1",
      feed_id: null,
      ics_uid: "11111111-1111-4111-8111-111111111111",
      course_id: "course-1",
      user_locked_fields: [],
      missing_since: null,
      title: "Hand in the group report",
      kind: "deadline",
      raw_summary: null,
      description: null,
      location: null,
      rrule: null,
      original_tzid: null,
      descriptor: null,
      session_from: null,
      session_to: null,
      hidden: false,
      is_exam_candidate: false,
      detection_source: null,
      weight_override: 25,
      sequence: 0,
    });

    events.current = [lecture("uid-D", "2026-09-10T08:00:00.000Z")];
    await syncFeed(store, "feed-1", at(0));

    // Ten days of syncs — long past the 7-day delete deadline. Without the
    // feed_id guard the manual item would have been tombstoned on the first run
    // and deleted here.
    for (let day = 1; day <= 10; day += 1) {
      await syncFeed(store, "feed-1", at(day));
    }

    const manual = state.items.find((item) => item.id === "manual-1");
    expect(manual).toBeDefined();
    expect(manual?.missing_since).toBeNull();
    expect(manual?.title).toBe("Hand in the group report");
    expect(manual?.weight_override).toBe(25);
  });
});

/* -------------------------------------------------------------------------- */
/* user_locked_fields                                                         */
/* -------------------------------------------------------------------------- */

describe("user_locked_fields (§3.3)", () => {
  it("never overwrites a locked title, even when the feed changes it", async () => {
    const { store, state } = createMemoryStore();

    events.current = [lecture("uid-E", "2026-09-10T08:00:00.000Z")];
    await syncFeed(store, "feed-1", at(0));

    const item = state.items[0];
    expect(item).toBeDefined();
    if (!item) throw new Error("unreachable");

    // The user renames it and the field becomes locked.
    item.title = "Graph algorithms — bring the problem set";
    item.user_locked_fields = ["title"];

    // The feed now supplies a different title, with a SEQUENCE bump for good
    // measure. A bump is exactly the case §3.3 calls out: it overwrites
    // everything EXCEPT locked fields.
    const upstream = lecture("uid-E", "2026-09-10T08:00:00.000Z");
    upstream.title = "ALGORITHMS & DATA STRUCTURES (Ses. 5)";
    upstream.sequence = 3;
    events.current = [upstream];
    await syncFeed(store, "feed-1", at(1));

    const after = state.items[0];
    expect(after?.title).toBe("Graph algorithms — bring the problem set");
    // Unlocked fields still track the feed, which is the other half of the rule.
    expect(after?.sequence).toBe(3);
  });

  it("keeps a reassigned course even when the matcher disagrees", async () => {
    const { store, state } = createMemoryStore({
      context: {
        timezone: "Europe/Madrid",
        courses: [
          {
            id: "course-algo",
            code: null,
            title: "ALGORITHMS & DATA STRUCTURES",
            total_sessions: 30,
          },
          { id: "course-mkt", code: null, title: "MARKETING MANAGEMENT", total_sessions: 20 },
        ],
        matchers: [],
        assessments: [],
        semesters: [],
      },
    });

    events.current = [lecture("uid-F", "2026-09-10T08:00:00.000Z")];
    await syncFeed(store, "feed-1", at(0));
    expect(state.items[0]?.course_id).toBe("course-algo");

    // "No, this one is actually Marketing."
    const item = state.items[0];
    if (!item) throw new Error("unreachable");
    item.course_id = "course-mkt";
    item.user_locked_fields = ["course_id"];

    // The matcher will keep resolving this summary to ALGORITHMS forever. The
    // lock has to beat it every single time, not just once.
    await syncFeed(store, "feed-1", at(1));
    await syncFeed(store, "feed-1", at(2));
    expect(state.items[0]?.course_id).toBe("course-mkt");
  });

  /**
   * ⚠ Archiving a course must not orphan its history.
   *
   * An archived course leaves the match context — that is what stops it
   * claiming newly synced events. Its already-linked rows then match nothing,
   * and before `preserveCourseLink` the diff wrote `course_id → null` on every
   * one of them, tipping a whole archived course into the Unassigned bucket.
   *
   * The required semantics, asserted here: **archiving excludes a course from
   * NEW matching; existing links survive.**
   */
  it("keeps existing course links when the course is archived out of the match context", async () => {
    const { store, state } = createMemoryStore({
      context: {
        timezone: "Europe/Madrid",
        courses: [
          {
            id: "course-algo",
            code: null,
            title: "ALGORITHMS & DATA STRUCTURES",
            total_sessions: 30,
          },
        ],
        matchers: [],
        assessments: [],
        semesters: [],
      },
    });

    events.current = [lecture("uid-G", "2026-09-10T08:00:00.000Z")];
    await syncFeed(store, "feed-1", at(0));
    expect(state.items[0]?.course_id).toBe("course-algo");
    expect(state.items[0]?.user_locked_fields).toEqual([]);

    // Archiving is exactly this: the course stops being offered to the matcher.
    state.context.courses = [];

    await syncFeed(store, "feed-1", at(1));
    await syncFeed(store, "feed-1", at(2));

    // Still filed. Not in the Unassigned bucket.
    expect(state.items[0]?.course_id).toBe("course-algo");
  });

  it("still assigns a course to an item that has none", async () => {
    const { store, state } = createMemoryStore({
      context: {
        timezone: "Europe/Madrid",
        courses: [],
        matchers: [],
        assessments: [],
        semesters: [],
      },
    });

    events.current = [lecture("uid-H", "2026-09-10T08:00:00.000Z")];
    await syncFeed(store, "feed-1", at(0));
    expect(state.items[0]?.course_id).toBeNull();

    // The guard is one-directional: it protects a link, it does not block one.
    state.context.courses = [
      { id: "course-algo", code: null, title: "ALGORITHMS & DATA STRUCTURES", total_sessions: 30 },
    ];
    await syncFeed(store, "feed-1", at(1));
    expect(state.items[0]?.course_id).toBe("course-algo");
  });

  it("still fills a locked field on FIRST insert, since there is nothing to protect yet", async () => {
    // A lock protects an existing value. On an insert there is none, and title
    // is `not null` — so a lock must not produce a row that cannot be written.
    const { store, state } = createMemoryStore();
    events.current = [lecture("uid-G", "2026-09-10T08:00:00.000Z")];
    await syncFeed(store, "feed-1", at(0));
    expect(state.items[0]?.title).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* Idempotence and the row diff                                               */
/* -------------------------------------------------------------------------- */

describe("idempotence (§3.2 layer 3, §3.3)", () => {
  it("writes zero occurrence changes on an identical re-run", async () => {
    const { store } = createMemoryStore();
    events.current = [
      lecture("uid-H", "2026-09-10T08:00:00.000Z"),
      lecture("uid-I", "2026-09-11T08:00:00.000Z"),
    ];

    const first = await syncFeed(store, "feed-1", at(0));
    expect(first).toMatchObject({ status: "ok", occurrencesWritten: 2, occurrencesUnchanged: 0 });

    // Same events, same payloads. Nothing may be written — otherwise
    // `updated_at` means "a sync ran", and §3.6 dates the strike-through on a
    // cancelled occurrence from exactly that column.
    const second = await syncFeed(store, "feed-1", at(0));
    expect(second).toMatchObject({ status: "ok", occurrencesWritten: 0, occurrencesUnchanged: 2 });
  });

  it("reports unchanged without touching a row when the provider skips", async () => {
    const { store, state } = createMemoryStore();
    events.current = [lecture("uid-J", "2026-09-10T08:00:00.000Z")];
    await syncFeed(store, "feed-1", at(0));

    changed.current = false; // a 304, or a byte-identical body
    const result = await syncFeed(store, "feed-1", at(1));

    expect(result).toEqual({ status: "unchanged" });
    // And emphatically NOT tombstoned: "the provider skipped" is not "the feed
    // returned an empty snapshot", and conflating them would wipe the calendar
    // every time the server answered 304.
    expect(state.items[0]?.missing_since).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Concurrency and cancellation                                               */
/* -------------------------------------------------------------------------- */

describe("per-feed concurrency guard (§3.1)", () => {
  it("skips silently while another run holds the lease", async () => {
    const { store, state } = createMemoryStore();
    state.feed.leaseExpiresAt = new Date(at(0).getTime() + 60_000).toISOString();

    expect(await syncFeed(store, "feed-1", at(0))).toEqual({
      status: "skipped",
      reason: "locked",
    });
  });
});

describe("cancellations (§3.6)", () => {
  it("marks an EXDATE-orphaned instance cancelled rather than deleting it", async () => {
    const { store, state } = createMemoryStore();

    const recurring = lecture("uid-K", "2026-09-10T08:00:00.000Z");
    recurring.occurrences = [
      { ...recurring.occurrences[0], recurrenceId: "2026-09-10T08:00:00Z" },
      { ...recurring.occurrences[0], recurrenceId: "2026-09-17T08:00:00Z" },
    ] as NormalizedEvent["occurrences"];
    events.current = [recurring];
    await syncFeed(store, "feed-1", at(0));
    expect(state.occurrences).toHaveLength(2);

    // The second instance is EXDATE'd upstream and stops being expanded.
    const trimmed = lecture("uid-K", "2026-09-10T08:00:00.000Z");
    trimmed.occurrences = [
      { ...trimmed.occurrences[0], recurrenceId: "2026-09-10T08:00:00Z" },
    ] as NormalizedEvent["occurrences"];
    events.current = [trimmed];
    const result = await syncFeed(store, "feed-1", at(1));

    expect(result).toMatchObject({ cancelled: 1 });
    // Kept, not deleted: "this lecture is not happening" is information, and a
    // silent gap in the week does not convey it.
    expect(state.occurrences).toHaveLength(2);
    expect(
      state.occurrences.find((entry) => entry.recurrence_id === "2026-09-17T08:00:00Z")?.status,
    ).toBe("cancelled");
  });

  it("carries a STATUS:CANCELLED occurrence straight through (form 1)", async () => {
    const { store, state } = createMemoryStore();
    const event = lecture("uid-L", "2026-09-10T08:00:00.000Z");
    event.occurrences = [
      { ...event.occurrences[0], status: "cancelled" },
    ] as NormalizedEvent["occurrences"];
    events.current = [event];

    await syncFeed(store, "feed-1", at(0));
    expect(state.occurrences[0]?.status).toBe("cancelled");
  });
});

/* -------------------------------------------------------------------------- */
/* The one-exam-per-course invariant, as sync sees it                         */
/* -------------------------------------------------------------------------- */

/**
 * 🔴 Both of these were found by applying the partial unique index
 * (`calendar_items_one_exam_per_course`, migration 20260718235227) to the live
 * database and watching the real feed sync **fail outright**:
 *
 *   Could not update calendar item: duplicate key value violates unique
 *   constraint "calendar_items_one_exam_per_course"
 *
 * Sync flags exam candidates row by row and checked the user's lock row by row
 * too, so a detector that picked a different session than the user did wrote a
 * second candidate for the course — and once that write is rejected, one
 * course's disagreement takes the entire feed's sync down with it.
 *
 * `patchItem` below enforces the index the way Postgres does, so these tests
 * fail the same way production did rather than only checking the end state.
 */
function withExamIndex(made: ReturnType<typeof createMemoryStore>) {
  const { store, state } = made;
  const original = store.patchItem.bind(store);
  store.patchItem = async (itemId: string, patch: object) => {
    const fields = patch as { is_exam_candidate?: boolean };
    if (fields.is_exam_candidate === true) {
      const target = state.items.find((item) => item.id === itemId);
      const clash = state.items.find(
        (item) =>
          item.id !== itemId &&
          item.course_id !== null &&
          item.course_id === target?.course_id &&
          item.is_exam_candidate,
      );
      if (clash) {
        throw new Error(
          'duplicate key value violates unique constraint "calendar_items_one_exam_per_course"',
        );
      }
    }
    return original(itemId, patch);
  };
  return made;
}

function session(uid: string, sessionNumber: number, startsAtUtc: string): NormalizedEvent {
  const event = lecture(uid, startsAtUtc);
  event.sessionFrom = sessionNumber;
  event.sessionTo = sessionNumber;
  event.rawSummary = `ALGORITHMS & DATA STRUCTURES   (Ses. ${sessionNumber}) T-03.01`;
  return event;
}

const EXAM_CONTEXT = (totalSessions: number) => ({
  context: {
    timezone: "Europe/Madrid",
    courses: [
      {
        id: "course-1",
        code: null,
        title: "ALGORITHMS & DATA STRUCTURES",
        total_sessions: totalSessions,
      },
    ],
    matchers: [],
    assessments: [],
    semesters: [],
  },
});

describe("sync and the one-exam-per-course invariant", () => {
  it("stops proposing for a course once the user has ruled on it", async () => {
    const { store, state } = withExamIndex(createMemoryStore(EXAM_CONTEXT(3)));

    events.current = [
      session("uid-s1", 1, "2026-09-08T08:00:00.000Z"),
      session("uid-s2", 2, "2026-09-15T08:00:00.000Z"),
      session("uid-s3", 3, "2026-09-22T08:00:00.000Z"),
    ];
    await syncFeed(store, "feed-1", at(0));

    // The detector picked the last session; the user disagrees and picks s1,
    // exactly as `planExamDecision` records it.
    const detected = state.items.find((item) => item.is_exam_candidate);
    expect(detected?.ics_uid).toBe("uid-s3");
    if (!detected) throw new Error("unreachable");
    detected.is_exam_candidate = false;
    detected.detection_source = null;

    const chosen = state.items.find((item) => item.ics_uid === "uid-s1");
    if (!chosen) throw new Error("unreachable");
    chosen.is_exam_candidate = true;
    chosen.detection_source = "manual";
    chosen.user_locked_fields = ["is_exam_candidate"];

    // The next sync must not re-flag s3.
    //
    // ⚠ Asserting the OUTCOME, not just the rows. `syncFeed` catches everything
    // and turns it into `{ status: "error" }`, so a version that trips the index
    // leaves the rows looking correct — the write simply never landed — while
    // the whole feed reports failure. That is precisely how this shipped: the
    // live feed's `last_sync_error` read "duplicate key value violates unique
    // constraint" while the exam panel looked perfectly fine.
    const outcome = await syncFeed(store, "feed-1", at(1));
    expect(outcome.status).toBe("ok");

    const flagged = state.items.filter((item) => item.is_exam_candidate);
    expect(flagged.map((item) => item.ics_uid)).toEqual(["uid-s1"]);
    expect(flagged[0]?.detection_source).toBe("manual");
  });

  it("moves the flag without ever holding two, when the detector's answer changes", async () => {
    const { store, state } = withExamIndex(createMemoryStore(EXAM_CONTEXT(2)));

    events.current = [
      session("uid-s1", 1, "2026-09-08T08:00:00.000Z"),
      session("uid-s2", 2, "2026-09-15T08:00:00.000Z"),
    ];
    await syncFeed(store, "feed-1", at(0));
    expect(state.items.find((item) => item.is_exam_candidate)?.ics_uid).toBe("uid-s2");

    // The syllabus count is corrected to 3 and the feed publishes that session,
    // so the detector's answer genuinely MOVES from s2 to s3. This is the case
    // that needs no user and no concurrency at all: one sync emits both a clear
    // and a set for the same course, and the set is rejected if it lands first.
    const course = state.context.courses[0];
    if (!course) throw new Error("unreachable");
    course.total_sessions = 3;
    events.current = [
      session("uid-s1", 1, "2026-09-08T08:00:00.000Z"),
      session("uid-s2", 2, "2026-09-15T08:00:00.000Z"),
      session("uid-s3", 3, "2026-09-22T08:00:00.000Z"),
    ];
    const outcome = await syncFeed(store, "feed-1", at(1));
    expect(outcome.status).toBe("ok");

    const flagged = state.items.filter((item) => item.is_exam_candidate);
    expect(flagged.map((item) => item.ics_uid)).toEqual(["uid-s3"]);
  });
});
