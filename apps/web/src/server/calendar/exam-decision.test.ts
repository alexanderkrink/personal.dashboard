import { describe, expect, it } from "vitest";
import {
  EXAM_CANDIDATE_FIELD,
  type ExamDecision,
  type ExamDecisionItem,
  isUserChosen,
  isUserRejected,
  planExamDecision,
} from "./exam-decision";

function item(id: string, overrides: Partial<ExamDecisionItem> = {}): ExamDecisionItem {
  return {
    id,
    is_exam_candidate: false,
    detection_source: null,
    user_locked_fields: [],
    ...overrides,
  };
}

/** The shape the live database is in: the detector flagged exactly one row. */
const DETECTED = [
  item("s1"),
  item("s29"),
  item("s30", { is_exam_candidate: true, detection_source: "syllabus_total_sessions" }),
];

/** Applies patches the way the action does, so assertions run over the result. */
function apply(items: readonly ExamDecisionItem[], decision: ExamDecision): ExamDecisionItem[] {
  const patches = new Map(planExamDecision(items, decision).map((patch) => [patch.id, patch]));
  return items.map((row) => {
    const patch = patches.get(row.id);
    return patch === undefined ? row : { ...row, ...patch };
  });
}

function flagged(items: readonly ExamDecisionItem[]): string[] {
  return items.filter((row) => row.is_exam_candidate).map((row) => row.id);
}

describe("planExamDecision — the one-candidate-per-course invariant", () => {
  it("set moves the flag: exactly one candidate, and it is the chosen row", () => {
    const after = apply(DETECTED, { intent: "set", itemId: "s29" });

    expect(flagged(after)).toEqual(["s29"]);
    expect(after.find((row) => row.id === "s29")?.detection_source).toBe("manual");
    // The row the detector had picked is cleared in the same operation.
    expect(after.find((row) => row.id === "s30")?.is_exam_candidate).toBe(false);
  });

  /**
   * 🔒 The reason this is a pure function rather than UI logic. A double
   * submit, a stale page or a sync racing a click can all leave two flagged
   * rows; a decision must converge to one regardless of what it started from.
   */
  it("collapses a corrupted multi-candidate course back to exactly one", () => {
    const corrupted = [
      item("s1", { is_exam_candidate: true, detection_source: "feed_max_session" }),
      item("s29", { is_exam_candidate: true, detection_source: "manual" }),
      item("s30", { is_exam_candidate: true, detection_source: "syllabus_total_sessions" }),
    ];

    expect(flagged(apply(corrupted, { intent: "set", itemId: "s30" }))).toEqual(["s30"]);
  });

  it("reject leaves no candidate at all", () => {
    const after = apply(DETECTED, { intent: "reject", itemId: "s30" });

    expect(flagged(after)).toEqual([]);
  });

  it("reject clears every flagged row, not only the one named", () => {
    const corrupted = [
      item("s29", { is_exam_candidate: true, detection_source: "manual" }),
      item("s30", { is_exam_candidate: true, detection_source: "syllabus_total_sessions" }),
    ];

    expect(flagged(apply(corrupted, { intent: "reject", itemId: "s30" }))).toEqual([]);
  });
});

describe("planExamDecision — locking", () => {
  it("locks is_exam_candidate on every row it records a decision about", () => {
    for (const decision of [
      { intent: "set", itemId: "s29" },
      { intent: "reject", itemId: "s30" },
    ] satisfies ExamDecision[]) {
      for (const patch of planExamDecision(DETECTED, decision)) {
        expect(patch.user_locked_fields).toContain(EXAM_CANDIDATE_FIELD);
      }
    }
  });

  /**
   * Locking every row of a course would freeze thirty ordinary lectures against
   * future detection because the user made one statement about one of them.
   */
  it("does not lock rows it has no decision about", () => {
    const patched = planExamDecision(DETECTED, { intent: "set", itemId: "s29" }).map(
      (patch) => patch.id,
    );

    expect(patched).not.toContain("s1");
  });

  it("reset removes the lock so detection may propose again", () => {
    const decided = apply(DETECTED, { intent: "reject", itemId: "s30" });
    const after = apply(decided, { intent: "reset" });

    for (const row of after) {
      expect(row.user_locked_fields).not.toContain(EXAM_CANDIDATE_FIELD);
      expect(row.is_exam_candidate).toBe(false);
      expect(row.detection_source).toBeNull();
    }
  });

  it("reset on an untouched course is a no-op", () => {
    expect(planExamDecision(DETECTED, { intent: "reset" })).toEqual([]);
  });
});

describe("planExamDecision — round trips", () => {
  /** ⚠ The dead end this whole slice exists to remove. */
  it("a rejection can be undone and the course returns to a proposable state", () => {
    const rejected = apply(DETECTED, { intent: "reject", itemId: "s30" });
    expect(rejected.some(isUserRejected)).toBe(true);

    const reset = apply(rejected, { intent: "reset" });
    expect(reset.some(isUserRejected)).toBe(false);
    expect(reset.some(isUserChosen)).toBe(false);
  });

  it("a rejection can be overridden directly by choosing a session", () => {
    const rejected = apply(DETECTED, { intent: "reject", itemId: "s30" });
    const chosen = apply(rejected, { intent: "set", itemId: "s29" });

    expect(flagged(chosen)).toEqual(["s29"]);
    expect(chosen.some(isUserRejected)).toBe(true); // s30 stays a recorded "not this one"
    expect(chosen.filter(isUserChosen).map((row) => row.id)).toEqual(["s29"]);
  });

  it("moving the exam twice leaves one candidate, not two", () => {
    const first = apply(DETECTED, { intent: "set", itemId: "s29" });
    const second = apply(first, { intent: "set", itemId: "s1" });

    expect(flagged(second)).toEqual(["s1"]);
  });

  it("emits no patch when the decision is already the stored state", () => {
    const chosen = apply(DETECTED, { intent: "set", itemId: "s29" });

    expect(planExamDecision(chosen, { intent: "set", itemId: "s29" })).toEqual([]);
  });
});

describe("isUserChosen / isUserRejected", () => {
  /**
   * The detector's own output must never read as a human decision — that is the
   * §5.1b confirm gate. `syllabus_total_sessions` is a machine answer.
   */
  it("a detector-flagged row is neither chosen nor rejected", () => {
    const detected = item("s30", {
      is_exam_candidate: true,
      detection_source: "syllabus_total_sessions",
    });

    expect(isUserChosen(detected)).toBe(false);
    expect(isUserRejected(detected)).toBe(false);
  });

  it("an untouched unflagged row is not a rejection", () => {
    expect(isUserRejected(item("s1"))).toBe(false);
  });

  it("an unflagged row carrying the lock is a rejection", () => {
    expect(isUserRejected(item("s1", { user_locked_fields: [EXAM_CANDIDATE_FIELD] }))).toBe(true);
  });
});
