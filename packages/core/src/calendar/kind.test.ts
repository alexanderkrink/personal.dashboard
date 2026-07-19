/**
 * Kind classification (§4) — ordered rules, first hit wins.
 *
 * **Rules 1 and 1b resolve the entire IE feed on their own.** The feed has no
 * recurrence, no `CATEGORIES` and no "due" tokens, so rules 2 and 3 are generic
 * provider capability that nothing in production currently reaches. Rule 1 is
 * therefore where the coverage goes: a recurrence-based rule (the obvious
 * design, and the one most ICS parsers use) would misfile **every** pre-expanded
 * IE VEVENT as `event`.
 */

import { describe, expect, it } from "vitest";
import { type ClassifyKindInput, classifyKind } from "./kind";
import type { NormalizedOccurrence } from "./provider";
import { normalizeSummary } from "./summary";

function occurrence(overrides: Partial<NormalizedOccurrence> = {}): NormalizedOccurrence {
  return {
    recurrenceId: "",
    startsAtUtc: "2026-09-01T08:00:00.000Z",
    endsAtUtc: "2026-09-01T09:20:00.000Z",
    allDay: false,
    status: "confirmed",
    overridden: false,
    ...overrides,
  };
}

/** Classifies a raw `SUMMARY` through the same normalizer the parser uses. */
function classify(
  rawSummary: string,
  overrides: Partial<Omit<ClassifyKindInput, "normalized">> = {},
) {
  const normalized = normalizeSummary(rawSummary);
  if (!normalized) {
    throw new Error(`Summary was classified as a pseudo row: ${rawSummary}`);
  }
  return classifyKind({
    normalized,
    occurrences: [occurrence()],
    hasRrule: false,
    categories: [],
    knownCourseNames: [],
    ...overrides,
  });
}

describe("rule 1 — the session-token rule (the IE path)", () => {
  it("classifies a single-session row as class", () => {
    expect(classify("CORPORATE FINANCE    (Ses. 3) T-03.01")).toBe("class");
  });

  it("classifies a ranged-session row as class", () => {
    expect(classify("BUILDING POWERFUL RELATIONSHIPS  (Ses. 24-25) T-04.02")).toBe("class");
  });

  it("classifies rows carrying junk before the session token", () => {
    expect(classify("IE HUMANITIES   | | | , null, null (Ses. 4-5) T-06.04")).toBe("class");
  });

  it("classifies Extra / Retake / Final Exam descriptors as class without a token", () => {
    expect(classify("MICROECONOMICS   Extra T-03.04")).toBe("class");
    expect(classify("APPLIED BUSINESS MATHEMATICS   Final EXAM Retake June ABM30")).toBe("class");
    expect(classify("CORPORATE FINANCE   Retake Exam June 2026")).toBe("class");
  });

  it("fires WITHOUT any recurrence — the reason a recurrence rule would fail", () => {
    // Every IE VEVENT is pre-expanded: 379 events, zero RRULEs. Rule 3 (RRULE +
    // duration → class) can never fire on this feed, so rule 1 has to.
    expect(classify("CORPORATE FINANCE    (Ses. 3) T-03.01", { hasRrule: false })).toBe("class");
  });

  it("wins over the deadline rule even on a zero-duration all-day row", () => {
    // Ordering check: rule 1 is consulted before rule 2, so a session-bearing
    // row stays a class rather than becoming a deadline.
    expect(
      classify("IE HUMANITIES    (Ses. 1) Asynchronous", {
        occurrences: [occurrence({ allDay: true, endsAtUtc: undefined })],
      }),
    ).toBe("class");
  });
});

describe("rule 1b — the known-course fallback", () => {
  const tokenless = "COST ACCOUNTING   |";

  it("drops a tokenless row to event when the course is unknown", () => {
    expect(classify(tokenless, { knownCourseNames: [] })).toBe("event");
  });

  it("lifts it to class once the course name is known", () => {
    expect(classify(tokenless, { knownCourseNames: ["COST ACCOUNTING"] })).toBe("class");
  });

  it("matches the junk-stripped course name, not the raw one", () => {
    // `courses.title` holds "COST ACCOUNTING"; the feed writes "COST ACCOUNTING   |".
    // Matching would fail without the §5.1b normalizer.
    expect(
      classify("COST ACCOUNTING   | | , null", { knownCourseNames: ["COST ACCOUNTING"] }),
    ).toBe("class");
  });

  it("compares case- and whitespace-insensitively", () => {
    expect(classify(tokenless, { knownCourseNames: ["cost   accounting"] })).toBe("class");
  });

  it("requires a real duration — a zero-duration row is not a lecture", () => {
    expect(
      classify(tokenless, {
        knownCourseNames: ["COST ACCOUNTING"],
        occurrences: [occurrence({ endsAtUtc: "2026-09-01T08:00:00.000Z" })],
      }),
    ).toBe("event");
  });

  it("does not match a different course with a similar prefix", () => {
    expect(
      classify("APPLIED BUSINESS MATHEMATICS   |", {
        knownCourseNames: ["MATHEMATICS FOR DATA MANAGEMENT AND ANALYSIS"],
      }),
    ).toBe("event");
  });
});

describe("rule 2 — deadlines (generic; the IE feed emits none)", () => {
  it("classifies a zero-duration `due` row as a deadline", () => {
    expect(
      classify("ML ASSIGNMENT 3   due 23:59", {
        occurrences: [occurrence({ endsAtUtc: "2026-09-01T08:00:00.000Z" })],
      }),
    ).toBe("deadline");
  });

  it("classifies an all-day `due` row as a deadline", () => {
    expect(classify("ML ASSIGNMENT 3   due", { occurrences: [occurrence({ allDay: true })] })).toBe(
      "deadline",
    );
  });

  it("does not fire on `due` when the row has a real duration", () => {
    expect(classify("ML ASSIGNMENT 3   due 23:59")).toBe("event");
  });

  it("classifies assignment-style CATEGORIES as a deadline", () => {
    for (const category of ["Assignment", "Homework", "Quiz", "Exam", "Deadline", "Task"]) {
      expect(classify("SOMETHING GENERIC   x", { categories: [category] })).toBe("deadline");
    }
  });

  it("ignores unrelated CATEGORIES values", () => {
    expect(classify("SOMETHING GENERIC   x", { categories: ["Holiday", "Personal"] })).toBe(
      "event",
    );
  });
});

describe("rule 3 — RRULE plus duration (generic; the IE feed has none)", () => {
  it("classifies a recurring, durationful row as a class", () => {
    expect(classify("SOME GENERIC FEED ROW   weekly", { hasRrule: true })).toBe("class");
  });

  it("does not fire on an RRULE with no duration", () => {
    expect(
      classify("SOME GENERIC FEED ROW   weekly", {
        hasRrule: true,
        occurrences: [occurrence({ endsAtUtc: undefined })],
      }),
    ).toBe("event");
  });
});

describe("rule 4 — everything else", () => {
  it("falls through to event", () => {
    expect(classify("CAREER FAIR   Main Hall")).toBe("event");
  });

  it("falls through to event with no occurrences at all", () => {
    expect(classify("CAREER FAIR   Main Hall", { occurrences: [] })).toBe("event");
  });
});

describe("rule ordering", () => {
  it("rule 1 beats rule 2 — a session-bearing row with a `due` token is a class", () => {
    expect(
      classify("CORPORATE FINANCE    (Ses. 3) report due", {
        occurrences: [occurrence({ allDay: true })],
      }),
    ).toBe("class");
  });

  it("rule 1b beats rule 2 — a known course with an assignment CATEGORIES is a class", () => {
    expect(
      classify("COST ACCOUNTING   |", {
        knownCourseNames: ["COST ACCOUNTING"],
        categories: ["Assignment"],
      }),
    ).toBe("class");
  });

  it("rule 2 beats rule 3 — a recurring `due` row is a deadline, not a class", () => {
    expect(
      classify("WEEKLY REPORT   due", {
        hasRrule: true,
        occurrences: [occurrence({ allDay: true })],
      }),
    ).toBe("deadline");
  });
});
