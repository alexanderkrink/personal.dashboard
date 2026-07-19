import { describe, expect, it } from "vitest";
import { buildExamStatuses, type ExamStatusCourse, type ExamStatusItem } from "./exam-status";

const COURSE_ID = "c-ads";

function course(overrides: Partial<ExamStatusCourse> = {}): ExamStatusCourse {
  return {
    id: COURSE_ID,
    title: "ALGORITHMS & DATA STRUCTURES",
    color: "indigo",
    total_sessions: 30,
    total_sessions_source: "feed_derived",
    ...overrides,
  };
}

/** One synced row, spelled the way the real IE feed spells it. */
function item(
  session: number,
  startsAt: string,
  overrides: Partial<ExamStatusItem> = {},
): ExamStatusItem {
  return {
    id: `item-${session}`,
    course_id: COURSE_ID,
    ics_uid: `uid-${session}`,
    raw_summary: `ALGORITHMS & DATA STRUCTURES   (Ses. ${session}) T-03.01`,
    starts_at: startsAt,
    is_exam_candidate: false,
    detection_source: null,
    user_locked_fields: [],
    ...overrides,
  };
}

const FULL_TERM = [
  item(1, "2026-09-01T07:30:00.000Z"),
  item(29, "2026-12-08T09:00:00.000Z"),
  item(30, "2026-12-10T10:30:00.000Z"),
];

describe("buildExamStatuses — provenance", () => {
  /**
   * 🚨 The finding this module exists for. The detector reports
   * `syllabus_total_sessions`, which *looks* authoritative — but the count was
   * read off this same feed, so steps 1 and 3 are one oracle read twice.
   */
  it("never presents a feed-derived session count as syllabus-confirmed", () => {
    const [status] = buildExamStatuses({
      courses: [course({ total_sessions_source: "feed_derived" })],
      items: FULL_TERM,
      assessments: [],
      semesters: [],
    });

    expect(status?.detection.outcome).toBe("found");
    // The detector's own vocabulary still says syllabus…
    expect(status?.detection.outcome === "found" && status.detection.source).toBe(
      "syllabus_total_sessions",
    );
    // …and the UI is told otherwise, because the data says otherwise.
    expect(status?.confidence).toBe("feed_derived");
    expect(status?.provenanceLabel).toContain("agreeing with itself");
  });

  it("reports syllabus confidence only when the course records a syllabus source", () => {
    const [status] = buildExamStatuses({
      courses: [course({ total_sessions_source: "syllabus" })],
      items: FULL_TERM,
      assessments: [],
      semesters: [],
    });

    expect(status?.confidence).toBe("syllabus");
    expect(status?.provenanceLabel).toBe("A syllabus declares 30 sessions.");
  });

  it("distinguishes a hand-entered session count from both", () => {
    const [status] = buildExamStatuses({
      courses: [course({ total_sessions_source: "manual" })],
      items: FULL_TERM,
      assessments: [],
      semesters: [],
    });

    expect(status?.confidence).toBe("manual");
  });

  it("labels a pure max-session fallback as fallback-derived", () => {
    const [status] = buildExamStatuses({
      courses: [course({ total_sessions: null, total_sessions_source: null })],
      items: FULL_TERM,
      assessments: [],
      semesters: [],
    });

    expect(status?.detection.outcome === "found" && status.detection.source).toBe(
      "feed_max_session",
    );
    expect(status?.confidence).toBe("feed_derived");
    expect(status?.provenanceLabel).toContain("No syllabus on file");
  });

  it("trusts a syllabus assessment row over the bare total", () => {
    const [status] = buildExamStatuses({
      courses: [course({ total_sessions: null, total_sessions_source: null })],
      items: FULL_TERM,
      assessments: [
        {
          id: "a1",
          course_id: COURSE_ID,
          title: "Final Exam",
          kind: "exam",
          session_number: 29,
          confirmed: true,
        },
      ],
      semesters: [],
    });

    expect(status?.detection.outcome === "found" && status.detection.source).toBe(
      "assessment_session_number",
    );
    expect(status?.confidence).toBe("syllabus");
  });

  it("does NOT trust an unconfirmed syllabus proposal (§2b)", () => {
    // A syllabus extraction that nobody has confirmed yet: rows born
    // `confirmed = false`, and `courses.total_sessions` deliberately still null
    // because the proposed count waits on the extraction row until confirmation.
    //
    // Without the confirmed filter this returned confidence "syllabus" and the
    // label "A syllabus assessment names this session." — the strongest claim the
    // UI can make, for a date no human had agreed to. Exam dates are a reserved
    // human-confirm class, so it must fall back to the honest feed-derived answer.
    const [status] = buildExamStatuses({
      courses: [course({ total_sessions: null, total_sessions_source: null })],
      items: FULL_TERM,
      assessments: [
        {
          id: "a1",
          course_id: COURSE_ID,
          title: "Final Exam",
          kind: "exam",
          session_number: 29,
          confirmed: false,
        },
      ],
      semesters: [],
    });

    expect(status?.detection.outcome === "found" && status.detection.source).not.toBe(
      "assessment_session_number",
    );
    expect(status?.confidence).not.toBe("syllabus");
    expect(status?.provenanceLabel).not.toContain("A syllabus assessment");
  });
});

describe("buildExamStatuses — the three outcomes", () => {
  it("found: names the item the exam resolved to", () => {
    const [status] = buildExamStatuses({
      courses: [course()],
      items: FULL_TERM,
      assessments: [],
      semesters: [],
    });

    expect(status?.detection.outcome).toBe("found");
    expect(status?.itemId).toBe("item-30");
  });

  /**
   * The state the REVISED chain exists to express: an oracle named session 30
   * and the feed has only published 24. Falling through to "session 24 is the
   * exam" would confidently report the wrong date.
   */
  it("pending: an oracle named session N that the feed has not published", () => {
    const [status] = buildExamStatuses({
      courses: [course({ total_sessions: 30 })],
      items: [item(1, "2026-09-01T07:30:00.000Z"), item(24, "2026-11-20T09:00:00.000Z")],
      assessments: [],
      semesters: [],
    });

    expect(status?.detection.outcome).toBe("pending");
    expect(status?.detection.outcome === "pending" && status.detection.expectedSessionNumber).toBe(
      30,
    );
    expect(status?.itemId).toBeNull();
  });

  it("unknown: no oracle, and no session numbers in the feed", () => {
    const [status] = buildExamStatuses({
      courses: [course({ total_sessions: null, total_sessions_source: null })],
      items: [
        item(1, "2026-09-01T07:30:00.000Z", {
          raw_summary: "ALGORITHMS & DATA STRUCTURES   T-03.01",
        }),
      ],
      assessments: [],
      semesters: [],
    });

    expect(status?.detection.outcome).toBe("unknown");
  });
});

describe("buildExamStatuses — conflicts and the confirm gate", () => {
  it("surfaces a syllabus/feed disagreement rather than picking silently", () => {
    const [status] = buildExamStatuses({
      courses: [course({ total_sessions: 30, total_sessions_source: "syllabus" })],
      items: [item(1, "2026-09-01T07:30:00.000Z"), item(24, "2026-11-20T09:00:00.000Z")],
      assessments: [],
      semesters: [],
    });

    expect(status?.conflict).toEqual({ declaredSessions: 30, feedMaxSession: 24 });
  });

  it("reports no conflict when the two oracles agree", () => {
    const [status] = buildExamStatuses({
      courses: [course()],
      items: FULL_TERM,
      assessments: [],
      semesters: [],
    });

    expect(status?.conflict).toBeNull();
  });

  it("is unconfirmed until a human writes detection_source = manual", () => {
    const unconfirmed = buildExamStatuses({
      courses: [course()],
      items: FULL_TERM,
      assessments: [],
      semesters: [],
    });
    expect(unconfirmed[0]?.confirmed).toBe(false);

    const confirmed = buildExamStatuses({
      courses: [course()],
      items: [
        ...FULL_TERM.slice(0, 2),
        item(30, "2026-12-10T10:30:00.000Z", {
          detection_source: "manual",
          is_exam_candidate: true,
        }),
      ],
      assessments: [],
      semesters: [],
    });
    expect(confirmed[0]?.confirmed).toBe(true);
  });
});

describe("buildExamStatuses — the user's decision outranks the detector", () => {
  function statusFor(items: readonly ExamStatusItem[], courseOverrides = {}) {
    const [status] = buildExamStatuses({
      courses: [course(courseOverrides)],
      items,
      assessments: [],
      semesters: [],
    });
    if (status === undefined) throw new Error("expected a status");
    return status;
  }

  it("shows the detector's proposal when nobody has ruled", () => {
    const status = statusFor(FULL_TERM);

    expect(status.decision).toBe("detected");
    expect(status.exam?.itemId).toBe("item-30");
    expect(status.confirmed).toBe(false);
  });

  /**
   * 🔴 The regression this slice fixes. The chain re-runs on every read, so a
   * rejection written to the database used to be re-detected and displayed
   * again — "Not an exam" looked like a button that did nothing.
   */
  it("shows NO exam once the user rejected it, even though detection still finds one", () => {
    const status = statusFor([
      ...FULL_TERM.slice(0, 2),
      item(30, "2026-12-10T10:30:00.000Z", {
        is_exam_candidate: false,
        detection_source: null,
        user_locked_fields: ["is_exam_candidate"],
      }),
    ]);

    // The detector has not changed its mind…
    expect(status.detection.outcome).toBe("found");
    // …and the panel shows nothing anyway, because a human said so.
    expect(status.decision).toBe("rejected");
    expect(status.exam).toBeNull();
  });

  it("a rejected course stays in the panel rather than disappearing", () => {
    const statuses = buildExamStatuses({
      courses: [course()],
      items: [
        ...FULL_TERM.slice(0, 2),
        item(30, "2026-12-10T10:30:00.000Z", { user_locked_fields: ["is_exam_candidate"] }),
      ],
      assessments: [],
      semesters: [],
    });

    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.decision).toBe("rejected");
  });

  it("shows the session the user nominated, not the one detection picked", () => {
    const status = statusFor([
      item(1, "2026-09-01T07:30:00.000Z"),
      item(29, "2026-12-08T09:00:00.000Z", {
        is_exam_candidate: true,
        detection_source: "manual",
        user_locked_fields: ["is_exam_candidate"],
      }),
      item(30, "2026-12-10T10:30:00.000Z", { user_locked_fields: ["is_exam_candidate"] }),
    ]);

    expect(status.decision).toBe("chosen");
    expect(status.confirmed).toBe(true);
    expect(status.exam?.itemId).toBe("item-29");
    expect(status.exam?.sessionNumber).toBe(29);
    // The detector's own answer is still reported, so the UI can offer it back.
    expect(status.detection.outcome === "found" && status.detection.sessionNumber).toBe(30);
  });

  it("offers every numbered session of the course as an alternative", () => {
    const status = statusFor(FULL_TERM);

    expect(status.sessions.map((session) => session.sessionNumber)).toEqual([1, 29, 30]);
    expect(status.sessions.map((session) => session.itemId)).toEqual([
      "item-1",
      "item-29",
      "item-30",
    ]);
  });

  it("addresses a ranged session by its last number, as the chain does", () => {
    const status = statusFor([
      item(1, "2026-09-01T07:30:00.000Z", {
        raw_summary: "ALGORITHMS & DATA STRUCTURES   (Ses. 1-2) T-03.01",
      }),
    ]);

    expect(status.sessions.map((session) => session.sessionNumber)).toEqual([2]);
  });

  it("offers no sessions when the feed carries no session tokens", () => {
    const status = statusFor(
      [item(1, "2026-09-01T07:30:00.000Z", { raw_summary: "ALGORITHMS & DATA STRUCTURES" })],
      { total_sessions: null, total_sessions_source: null },
    );

    expect(status.sessions).toEqual([]);
  });
});

/**
 * 🚨 The honesty signal, asserted against every user action that could plausibly
 * be read as "the user vouched for this, so upgrade it".
 *
 * None of them may. `confidence` is a statement about where the **session
 * count** came from, and the session count came off the feed no matter who
 * clicks what. Gate 4/5 verified this property; these tests are what stop it
 * being lost the next time the panel is edited.
 */
describe("buildExamStatuses — confirming never upgrades provenance", () => {
  const CIRCULAR = { total_sessions: 30, total_sessions_source: "feed_derived" };

  it("a confirmed feed-derived exam is still labelled feed-derived", () => {
    const [status] = buildExamStatuses({
      courses: [course(CIRCULAR)],
      items: [
        ...FULL_TERM.slice(0, 2),
        item(30, "2026-12-10T10:30:00.000Z", {
          is_exam_candidate: true,
          detection_source: "manual",
          user_locked_fields: ["is_exam_candidate"],
        }),
      ],
      assessments: [],
      semesters: [],
    });

    expect(status?.confirmed).toBe(true);
    expect(status?.decision).toBe("chosen");
    expect(status?.confidence).toBe("feed_derived");
    expect(status?.provenanceLabel).toContain("agreeing with itself");
  });

  it("hand-picking a different session does not upgrade it either", () => {
    const [status] = buildExamStatuses({
      courses: [course(CIRCULAR)],
      items: [
        item(1, "2026-09-01T07:30:00.000Z"),
        item(29, "2026-12-08T09:00:00.000Z", {
          is_exam_candidate: true,
          detection_source: "manual",
          user_locked_fields: ["is_exam_candidate"],
        }),
        item(30, "2026-12-10T10:30:00.000Z", { user_locked_fields: ["is_exam_candidate"] }),
      ],
      assessments: [],
      semesters: [],
    });

    expect(status?.confidence).toBe("feed_derived");
    expect(status?.provenanceLabel).toContain("agreeing with itself");
  });

  it("only the recorded course provenance can lift the label", () => {
    const [status] = buildExamStatuses({
      courses: [course({ total_sessions: 30, total_sessions_source: "syllabus" })],
      items: FULL_TERM,
      assessments: [],
      semesters: [],
    });

    expect(status?.confidence).toBe("syllabus");
  });
});

describe("buildExamStatuses — input hygiene", () => {
  /**
   * Two of the 5 pseudo rows carry a REAL course prefix, so a filter keyed on
   * "no course name" lets them through. `normalizeSummary` returns null for
   * them; letting one reach the detector would put a Smowl proctoring check in
   * the session-number domain.
   */
  it("drops pseudo/LMS rows before they reach the detector", () => {
    const [status] = buildExamStatuses({
      courses: [course({ total_sessions: null, total_sessions_source: null })],
      items: [
        item(1, "2026-09-01T07:30:00.000Z"),
        item(99, "2026-09-02T07:30:00.000Z", {
          raw_summary: "**Last Update (IE Calendar)**",
        }),
      ],
      assessments: [],
      semesters: [],
    });

    expect(status?.detection.outcome === "found" && status.detection.sessionNumber).toBe(1);
  });

  it("omits courses the feed has never mentioned", () => {
    const statuses = buildExamStatuses({
      courses: [course(), course({ id: "c-other", title: "UNSYNCED COURSE" })],
      items: FULL_TERM,
      assessments: [],
      semesters: [],
    });

    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.course.id).toBe(COURSE_ID);
  });
});

/**
 * §5.1b guard 2, which until 2026-07-19 was computed and thrown away.
 *
 * `boundsFlags` has always produced `outsideSemester` onto `detection.flags`,
 * but the read path (`this-week.tsx`) passed `semesters: []` — and with no rows
 * the guard returns `{ unbounded: true, outsideSemester: false }` unconditionally.
 * It was a constant wearing the shape of a check. These cases pin the behaviour
 * now that the real rows are threaded through.
 */
describe("buildExamStatuses — semester bounds (guard 2)", () => {
  // The live rows, 2026-07-19.
  const FALL = { starts_on: "2026-08-31", ends_on: "2026-12-18" };
  const SPRING = { starts_on: "2027-01-11", ends_on: "2027-05-21" };

  it("does not flag an exam that falls inside a semester", () => {
    const [status] = buildExamStatuses({
      courses: [course()],
      items: FULL_TERM,
      assessments: [],
      semesters: [FALL, SPRING],
    });

    expect(status?.detection.outcome).toBe("found");
    expect(status?.outsideSemester).toBe(false);
  });

  it("flags an exam that falls outside every semester", () => {
    // Session 30 moved into the Christmas gap between the two terms.
    const [status] = buildExamStatuses({
      courses: [course()],
      items: [item(1, "2026-09-01T07:30:00.000Z"), item(30, "2026-12-29T10:30:00.000Z")],
      assessments: [],
      semesters: [FALL, SPRING],
    });

    expect(status?.detection.outcome).toBe("found");
    expect(status?.outsideSemester).toBe(true);
  });

  /**
   * ⚠ The off-by-one-day trap that wiring real rows exposed.
   *
   * `semesters.ends_on` is a DATE. `Date.parse("2026-12-18")` is midnight UTC
   * *starting* the 18th, so an exam at 10:30 on the final day of term compares as
   * outside it. Passing the column through raw would have made the guard's very
   * first real firing a false positive — on the last teaching day, which is
   * exactly where finals sit.
   */
  it("counts the final day of term as inside it, not outside", () => {
    const [status] = buildExamStatuses({
      courses: [course()],
      items: [item(1, "2026-09-01T07:30:00.000Z"), item(30, "2026-12-18T10:30:00.000Z")],
      assessments: [],
      semesters: [FALL, SPRING],
    });

    expect(status?.outsideSemester).toBe(false);
  });

  it("never flags when no semesters are on file — that is missing config, not a bad date", () => {
    // `unbounded` is true here, but `outsideSemester` is not, and only the latter
    // is surfaced. Warning on every row when term dates are simply absent would
    // train the user to ignore the warning that matters.
    const [status] = buildExamStatuses({
      courses: [course()],
      items: FULL_TERM,
      assessments: [],
      semesters: [],
    });

    expect(status?.outsideSemester).toBe(false);
  });
});
