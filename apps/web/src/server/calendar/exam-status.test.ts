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
        },
      ],
      semesters: [],
    });

    expect(status?.detection.outcome === "found" && status.detection.source).toBe(
      "assessment_session_number",
    );
    expect(status?.confidence).toBe("syllabus");
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
