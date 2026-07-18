/**
 * Exam detection — the REVISED §5.1b oracle chain.
 *
 * ## What actually runs, and therefore what is tested hardest
 *
 * 🔴 All three syllabi on disk are 2025-26 first-year documents mapping to
 * **none** of the 7 fall-2026 courses (`APPLIED BUSINESS MATHEMATICS` and
 * `MATHEMATICS FOR DATA MANAGEMENT AND ANALYSIS` are genuinely different
 * courses — the feed carries both). `assessments` is deliberately 0 rows, while
 * `courses.total_sessions` is seeded. So:
 *
 * - step 1 (`courses.total_sessions`) — live wherever the column is populated;
 * - step 2 (`assessments.session_number`) — **currently dead**, no rows exist;
 * - step 3 (`max(sessionTo)`) — **the live path for all 7 fall courses.**
 *
 * Step 3 and its three guards are therefore not a rare branch, and the
 * three-outcome distinction is the whole point of the reordering. Both get the
 * most coverage here. (The end-to-end proof that all 7 fall courses really do
 * resolve through step 3 lives in `real-feed.test.ts`, against the real export.)
 */

import { describe, expect, it } from "vitest";
import { detectExam, type ExamCandidateEvent, maxSessionNumber } from "./exam-detection";
import { normalizeSummary } from "./summary";

/**
 * Builds a candidate event from a raw `SUMMARY`, so the tests exercise the same
 * normalizer the parser uses rather than hand-built session numbers.
 */
function event(uid: string, startsAtUtc: string, rawSummary: string): ExamCandidateEvent {
  const summary = normalizeSummary(rawSummary);
  if (!summary) {
    throw new Error(`Fixture summary was classified as a pseudo row: ${rawSummary}`);
  }
  return { uid, startsAtUtc, summary };
}

/** A course whose feed rows run 1..30, one session per event. */
function completeCourse(): ExamCandidateEvent[] {
  return Array.from({ length: 30 }, (_, index) =>
    event(
      `SES-${index + 1}`,
      `2026-09-${String(index + 1).padStart(2, "0")}T08:00:00.000Z`,
      `MARKETING MANAGEMENT    (Ses. ${index + 1}) T-06.02`,
    ),
  );
}

/** The same course, but the feed has only published through session 24. */
function incompleteCourse(): ExamCandidateEvent[] {
  return completeCourse().slice(0, 24);
}

const FALL_2026: ReadonlyArray<{ startsAt: string; endsAt: string }> = [
  { startsAt: "2026-09-01T00:00:00.000Z", endsAt: "2026-12-20T23:59:59.000Z" },
];

describe("maxSessionNumber — ranges are expanded, not read naively", () => {
  it("takes the M of a ranged (Ses. N-M) row", () => {
    const events = [
      event(
        "A",
        "2026-12-09T10:00:00.000Z",
        "BUILDING POWERFUL RELATIONSHIPS  (Ses. 24-25) T-04.02",
      ),
      event(
        "B",
        "2026-12-02T10:00:00.000Z",
        "BUILDING POWERFUL RELATIONSHIPS  (Ses. 22-23) T-04.02",
      ),
    ];
    // Reading `sessionFrom` would say 24; the course actually reaches 25.
    expect(maxSessionNumber(events)).toBe(25);
  });

  it("returns null when no event carries a session token", () => {
    expect(
      maxSessionNumber([
        event("A", "2026-06-02T14:00:00.000Z", "APPLIED BUSINESS MATHEMATICS   Extra T-05.01"),
      ]),
    ).toBeNull();
  });
});

/**
 * ## Outcome 1 of 3 — "exam found"
 *
 * An oracle named session N and the feed has an event carrying it.
 */
describe("outcome: exam FOUND", () => {
  it("step 1 — courses.total_sessions names session 30 and the feed has it", () => {
    const detection = detectExam({
      events: completeCourse(),
      totalSessions: 30,
      semesters: FALL_2026,
    });

    expect(detection.outcome).toBe("found");
    if (detection.outcome !== "found") return;
    expect(detection.source).toBe("syllabus_total_sessions");
    expect(detection.sessionNumber).toBe(30);
    expect(detection.uid).toBe("SES-30");
    expect(detection.startsAtUtc).toBe("2026-09-30T08:00:00.000Z");
    expect(detection.flags).toEqual({ unbounded: false, outsideSemester: false });
  });

  it("step 2 — an assessments.session_number match, when rows exist", () => {
    const detection = detectExam({
      events: completeCourse(),
      // No total_sessions, so the chain falls to the assessments oracle.
      // Values are the REAL schema's: `kind` is constrained to
      // ('exam','quiz','project','participation','paper','other'), so a final and
      // a midterm are both 'exam' and only `title` tells them apart.
      assessments: [
        { id: "a-mid", title: "In class Midterm Exam", kind: "exam", sessionNumber: 19 },
        { id: "a-final", title: "Final Exam", kind: "exam", sessionNumber: 30 },
        { id: "a-part", title: "Participation", kind: "participation", sessionNumber: null },
      ],
      semesters: FALL_2026,
    });

    expect(detection.outcome).toBe("found");
    if (detection.outcome !== "found") return;
    expect(detection.source).toBe("assessment_session_number");
    // The FINAL, not the midterm — selected on title, since both are kind 'exam'.
    expect(detection.sessionNumber).toBe(30);
    expect(detection.uid).toBe("SES-30");
  });

  it("picks the last exam when no title names the final", () => {
    // LOES-style: several `kind='exam'` rows with session numbers, none titled
    // "Final". The final is the last exam, so the highest session wins.
    const detection = detectExam({
      events: completeCourse(),
      assessments: [
        { id: "a-1", title: "Intermediate test 1", kind: "exam", sessionNumber: 10 },
        { id: "a-2", title: "Intermediate test 2", kind: "exam", sessionNumber: 30 },
      ],
    });
    expect(detection.outcome).toBe("found");
    if (detection.outcome !== "found") return;
    expect(detection.source).toBe("assessment_session_number");
    expect(detection.sessionNumber).toBe(30);
  });

  it("ignores non-exam kinds even when they carry a session number", () => {
    const detection = detectExam({
      events: completeCourse(),
      assessments: [
        { id: "a-quiz", title: "Final MC Quiz", kind: "quiz", sessionNumber: 12 },
        { id: "a-proj", title: "Group Research Presentation", kind: "project", sessionNumber: 28 },
      ],
    });
    // No exam-kind row → step 2 declines and the fallback takes over.
    expect(detection.outcome).toBe("found");
    if (detection.outcome !== "found") return;
    expect(detection.source).toBe("feed_max_session");
    expect(detection.sessionNumber).toBe(30);
  });

  it("prefers step 1 over step 2 when both are available", () => {
    const detection = detectExam({
      events: completeCourse(),
      totalSessions: 30,
      assessments: [{ id: "a-final", title: "Final Exam", kind: "exam", sessionNumber: 19 }],
    });
    expect(detection.outcome).toBe("found");
    if (detection.outcome !== "found") return;
    expect(detection.source).toBe("syllabus_total_sessions");
    expect(detection.sessionNumber).toBe(30);
  });
});

/**
 * ## Outcome 2 of 3 — "exam not yet published, expect session N"
 *
 * This state is the entire reason the chain was reordered. `max(sessionTo)`
 * conflates *"session N is the last one"* with *"session N is the last one
 * **published so far**"*; only a syllabus-declared total can tell them apart.
 *
 * The critical property is the **absence of a fallthrough**: a named session the
 * feed cannot supply must NOT quietly drop to step 3, because that would report
 * session 24's date as the exam with full confidence.
 */
describe("outcome: exam PENDING — named but not yet published", () => {
  it("step 1 names session 30 but the feed stops at 24", () => {
    const detection = detectExam({
      events: incompleteCourse(),
      totalSessions: 30,
      semesters: FALL_2026,
    });

    expect(detection.outcome).toBe("pending");
    if (detection.outcome !== "pending") return;
    expect(detection.source).toBe("syllabus_total_sessions");
    expect(detection.expectedSessionNumber).toBe(30);
  });

  it("does NOT fall through to max(sessionTo) — the whole point of the reorder", () => {
    const detection = detectExam({
      events: incompleteCourse(),
      totalSessions: 30,
    });

    // The dangerous answer would be `found` at session 24 (2026-09-24), which is
    // a real class, not the exam. `pending` is the honest one.
    expect(detection.outcome).not.toBe("found");
    expect(maxSessionNumber(incompleteCourse())).toBe(24);
    if (detection.outcome !== "pending") return;
    expect(detection.expectedSessionNumber).toBe(30);
    expect(detection).not.toHaveProperty("startsAtUtc");
  });

  it("step 2 can also be pending", () => {
    const detection = detectExam({
      events: incompleteCourse(),
      assessments: [{ id: "a-final", title: "Final Exam", kind: "exam", sessionNumber: 30 }],
    });
    expect(detection.outcome).toBe("pending");
    if (detection.outcome !== "pending") return;
    expect(detection.source).toBe("assessment_session_number");
    expect(detection.expectedSessionNumber).toBe(30);
  });
});

/**
 * ## Outcome 3 of 3 — "fallback-derived"
 *
 * No syllabus on file. `max(sessionTo)` is used and the result is flagged as
 * fallback-derived (`source: "feed_max_session"`) so the UI never presents it
 * with syllabus-grade confidence. **This is the live path for all 7 fall-2026
 * courses.**
 */
describe("outcome: FALLBACK-derived — max(sessionTo), the only live path today", () => {
  it("derives the exam from the highest session number with no oracle at all", () => {
    const detection = detectExam({ events: completeCourse(), semesters: FALL_2026 });

    expect(detection.outcome).toBe("found");
    if (detection.outcome !== "found") return;
    // The outcome is `found`, but the SOURCE is what marks it fallback-derived —
    // matching `calendar_items.detection_source`, which exists precisely so
    // "exam found" and "fallback-derived" are distinguishable downstream.
    expect(detection.source).toBe("feed_max_session");
    expect(detection.sessionNumber).toBe(30);
    expect(detection.uid).toBe("SES-30");
  });

  it("expands ranged rows, so a 34-event course resolves to session 35", () => {
    // PROBABILITY & STATISTICS: 34 events, 35 sessions. Reading sessionFrom, or
    // counting events, both land on the wrong session.
    const events = [
      ...Array.from({ length: 33 }, (_, index) =>
        event(
          `PS-${index + 1}`,
          `2026-09-${String(index + 1).padStart(2, "0")}T08:00:00.000Z`,
          `PROBABILITY & STATISTICS FOR DATA MANAGEMENT AND ANALYSIS    (Ses. ${index + 1}) T-04.02`,
        ),
      ),
      event(
        "PS-RANGE",
        "2026-12-11T10:30:00.000Z",
        "PROBABILITY & STATISTICS FOR DATA MANAGEMENT AND ANALYSIS    (Ses. 34-35) T-04.02",
      ),
    ];
    expect(events).toHaveLength(34);

    const detection = detectExam({ events, semesters: FALL_2026 });
    expect(detection.outcome).toBe("found");
    if (detection.outcome !== "found") return;
    expect(detection.sessionNumber).toBe(35);
    expect(detection.uid).toBe("PS-RANGE");
  });

  it("reports `unknown` when there is no oracle and no session token anywhere", () => {
    const detection = detectExam({
      events: [
        event("A", "2026-06-02T14:00:00.000Z", "APPLIED BUSINESS MATHEMATICS   Extra T-05.01"),
      ],
    });
    expect(detection.outcome).toBe("unknown");
  });
});

/**
 * ## The fallback's three guards
 *
 * Not a rare path — today they are the ONLY path, so each is tested directly.
 */
describe("fallback guard 1 — earliest date wins among ties", () => {
  it("defeats a retake that reuses the final session number", () => {
    const events = [
      ...completeCourse(),
      // A June re-sit that (hypothetically — today's feed never does this) reuses
      // session 30. Chronologically last, so any date-ordered rule picks it.
      event(
        "RETAKE-REUSING-30",
        "2027-06-15T14:00:00.000Z",
        "MARKETING MANAGEMENT    (Ses. 30) Retake Exam June 2027",
      ),
    ];

    const detection = detectExam({ events });
    expect(detection.outcome).toBe("found");
    if (detection.outcome !== "found") return;
    expect(detection.sessionNumber).toBe(30);
    // The ORIGINAL session 30, not the re-sit sharing its number.
    expect(detection.uid).toBe("SES-30");
    expect(detection.startsAtUtc).toBe("2026-09-30T08:00:00.000Z");
  });

  it("never orders by date — session numbers are not monotonic in the real feed", () => {
    // Corporate Finance: Ses. 11 on 02-27, Ses. 10 on 03-02. Chronology says the
    // last session is 10; the session number says 11.
    const events = [
      event("CF-11", "2026-02-27T11:00:00.000Z", "CORPORATE FINANCE    (Ses. 11) T-03.01"),
      event("CF-10", "2026-03-02T11:00:00.000Z", "CORPORATE FINANCE    (Ses. 10) T-03.01"),
    ];

    const detection = detectExam({ events });
    expect(detection.outcome).toBe("found");
    if (detection.outcome !== "found") return;
    expect(detection.sessionNumber).toBe(11);
    expect(detection.uid).toBe("CF-11");
    // Deliberately the EARLIER of the two dates — proof chronology lost.
    expect(detection.startsAtUtc).toBe("2026-02-27T11:00:00.000Z");
  });
});

describe("fallback guard 2 — semester bounds SKIP AND FLAG, never discard", () => {
  it("flags `unbounded` when no semesters row covers the candidate", () => {
    // The 2025/26 term has no `semesters` row while the feed carries 225 events
    // from 2026-01-19. A strict bounds check would silently drop half the sample.
    const events = [
      event("SPRING-1", "2026-02-27T11:00:00.000Z", "CORPORATE FINANCE    (Ses. 11) T-03.01"),
    ];

    const detection = detectExam({ events, semesters: FALL_2026 });
    expect(detection.outcome).toBe("found");
    if (detection.outcome !== "found") return;
    // Kept, not discarded — that is the correction.
    expect(detection.uid).toBe("SPRING-1");
    expect(detection.flags.unbounded).toBe(true);
    expect(detection.flags.outsideSemester).toBe(true);
  });

  it("flags `unbounded` when there are no semesters rows at all", () => {
    const detection = detectExam({ events: completeCourse(), semesters: [] });
    expect(detection.outcome).toBe("found");
    if (detection.outcome !== "found") return;
    expect(detection.flags).toEqual({ unbounded: true, outsideSemester: false });
  });

  it("clears both flags when a semesters row does cover the candidate", () => {
    const detection = detectExam({ events: completeCourse(), semesters: FALL_2026 });
    expect(detection.outcome).toBe("found");
    if (detection.outcome !== "found") return;
    expect(detection.flags).toEqual({ unbounded: false, outsideSemester: false });
  });
});

describe("fallback guard 3 — retakes are tagged and hidden, NEVER deleted", () => {
  const retakeEvents = [
    ...completeCourse(),
    event(
      "RETAKE-JUNE",
      "2027-06-15T14:00:00.000Z",
      "MARKETING MANAGEMENT   Final EXAM Retake June MM20",
    ),
  ];

  it("collects a session-less retake occurring after the max-session date", () => {
    const detection = detectExam({ events: retakeEvents, semesters: FALL_2026 });
    expect(detection.outcome).toBe("found");
    if (detection.outcome !== "found") return;

    // Present in the output — surfaced, not dropped on the floor.
    expect(detection.retakes).toHaveLength(1);
    expect(detection.retakes[0]?.uid).toBe("RETAKE-JUNE");
    expect(detection.retakes[0]?.rawSummary).toContain("Retake");

    // ...and it did not become the exam candidate.
    expect(detection.uid).toBe("SES-30");
  });

  it("matches resit and convocatoria as well as retake", () => {
    for (const word of ["Retake", "Resit", "Convocatoria"]) {
      const detection = detectExam({
        events: [
          ...completeCourse(),
          event("R", "2027-06-15T14:00:00.000Z", `MARKETING MANAGEMENT   Final EXAM ${word} June`),
        ],
      });
      expect(detection.outcome).toBe("found");
      if (detection.outcome !== "found") continue;
      expect(detection.retakes).toHaveLength(1);
    }
  });

  it("does not tag an event that carries a session number", () => {
    // Verified: every retake in the real feed carries NO `(Ses. N)` token — IE
    // writes it in prose ("ABM30"). An event with a session number is inside the
    // session domain and is handled by guard 1, not guard 3.
    const detection = detectExam({
      events: [
        ...completeCourse(),
        event(
          "SESSIONED-RETAKE",
          "2027-06-15T14:00:00.000Z",
          "MARKETING MANAGEMENT    (Ses. 30) Retake Exam June 2027",
        ),
      ],
    });
    expect(detection.outcome).toBe("found");
    if (detection.outcome !== "found") return;
    expect(detection.retakes).toHaveLength(0);
  });

  it("ignores a retake that predates the exam candidate", () => {
    const detection = detectExam({
      events: [
        ...completeCourse(),
        // A re-sit of the PREVIOUS year's course, before this course's final.
        event("OLD-RETAKE", "2026-06-15T14:00:00.000Z", "MARKETING MANAGEMENT   Retake June 2026"),
      ],
    });
    expect(detection.outcome).toBe("found");
    if (detection.outcome !== "found") return;
    expect(detection.retakes).toHaveLength(0);
  });

  it("still surfaces retakes on the pending and unknown outcomes", () => {
    const pending = detectExam({
      events: [
        ...incompleteCourse(),
        event("R", "2027-06-15T14:00:00.000Z", "MARKETING MANAGEMENT   Retake June 2027"),
      ],
      totalSessions: 30,
    });
    expect(pending.outcome).toBe("pending");
    expect(pending.retakes).toHaveLength(1);

    const unknown = detectExam({
      events: [event("R", "2027-06-15T14:00:00.000Z", "SOME COURSE   Retake June 2027")],
    });
    expect(unknown.outcome).toBe("unknown");
    expect(unknown.retakes).toHaveLength(1);
  });
});

describe("the three outcomes are distinguishable by (outcome, source)", () => {
  it("yields a different pair for found / pending / fallback-derived", () => {
    const found = detectExam({ events: completeCourse(), totalSessions: 30 });
    const pending = detectExam({ events: incompleteCourse(), totalSessions: 30 });
    const fallback = detectExam({ events: completeCourse() });

    const describeOutcome = (detection: ReturnType<typeof detectExam>): string =>
      detection.outcome === "unknown" ? "unknown" : `${detection.outcome}:${detection.source}`;

    expect(describeOutcome(found)).toBe("found:syllabus_total_sessions");
    expect(describeOutcome(pending)).toBe("pending:syllabus_total_sessions");
    expect(describeOutcome(fallback)).toBe("found:feed_max_session");

    expect(
      new Set([describeOutcome(found), describeOutcome(pending), describeOutcome(fallback)]).size,
    ).toBe(3);
  });
});

describe("degenerate oracle values fall through rather than throwing", () => {
  it("ignores a non-positive or non-finite total_sessions", () => {
    for (const totalSessions of [0, -5, Number.NaN, null, undefined]) {
      const detection = detectExam({ events: completeCourse(), totalSessions });
      expect(detection.outcome).toBe("found");
      if (detection.outcome !== "found") continue;
      // Fell through to the fallback rather than resolving session 0 or NaN.
      expect(detection.source).toBe("feed_max_session");
    }
  });

  it("ignores assessments whose session_number is null", () => {
    const detection = detectExam({
      events: completeCourse(),
      assessments: [{ id: "a", title: "Final Exam", kind: "exam", sessionNumber: null }],
    });
    expect(detection.outcome).toBe("found");
    if (detection.outcome !== "found") return;
    expect(detection.source).toBe("feed_max_session");
  });
});
