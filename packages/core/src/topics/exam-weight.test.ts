import { describe, expect, it } from "vitest";
import { computeExamWeight, EXAM_WEIGHT_FLOOR, type ExamWeightInput } from "./exam-weight";

/**
 * §9's three load-bearing properties of the weight blend, each a two-clause test: a green
 * clause that the feature must keep passing, and a RED clause that trips on the exact broken
 * input the guard exists to catch. Mutation-verified — see the block above each.
 */

/** A moderately-supported topic, deliberately far from both 0 and 1 so a term can move it. */
const MODERATE: ExamWeightInput = {
  override: null,
  signalCount: 0,
  sourceCount: 2,
  recencyFactor: 0.5,
  formulaCount: 1,
  workedExampleCount: 1,
};

describe("computeExamWeight — override dominance (§9d)", () => {
  // RED against a blend that merely weights the override: flipping the early return to
  // `EXAM_WEIGHT_TERMS.* * ... + override * k` makes this land near the floor, not on 0.9.
  it("returns the override EXACTLY when set, ignoring every other signal", () => {
    const weight = computeExamWeight({
      override: 0.9,
      signalCount: 0,
      sourceCount: 0,
      recencyFactor: 0,
      formulaCount: 0,
      workedExampleCount: 0,
    });
    expect(weight).toBe(0.9);
  });

  it("clamps a malformed override into range but still returns it outright", () => {
    expect(computeExamWeight({ ...MODERATE, override: 1 })).toBe(1);
    expect(computeExamWeight({ ...MODERATE, override: 0 })).toBe(0);
  });

  it("a maximally-supported topic still yields to a low override", () => {
    const loud: ExamWeightInput = {
      override: 0.1,
      signalCount: 9,
      sourceCount: 9,
      recencyFactor: 1,
      formulaCount: 9,
      workedExampleCount: 9,
    };
    expect(computeExamWeight(loud)).toBe(0.1);
  });
});

describe("computeExamWeight — signal monotonicity (§9a)", () => {
  // RED against dropping the signal term (set EXAM_WEIGHT_TERMS.signal to 0, or omit
  // signalScore from the sum): the two weights become equal and the strict `>` fails.
  it("a topic with an exam signal scores STRICTLY higher than the same topic without", () => {
    const without = computeExamWeight({ ...MODERATE, signalCount: 0 });
    const withSignal = computeExamWeight({ ...MODERATE, signalCount: 1 });
    expect(withSignal).toBeGreaterThan(without);
  });

  it("more signals never lower the weight", () => {
    const one = computeExamWeight({ ...MODERATE, signalCount: 1 });
    const three = computeExamWeight({ ...MODERATE, signalCount: 3 });
    expect(three).toBeGreaterThanOrEqual(one);
  });
});

describe("computeExamWeight — the floor is not the 0.5 default (§9)", () => {
  // RED against a blend seeded at the inert 0.5 default (change EXAM_WEIGHT_FLOOR to 0.5, or
  // `return 0.5` for the unsupported case): this asserts the weak topic sits WELL below 0.5.
  it("no signals + a single stale source + no artifacts sits near the low floor", () => {
    const weak = computeExamWeight({
      override: null,
      signalCount: 0,
      sourceCount: 1,
      recencyFactor: 0, // stale
      formulaCount: 0,
      workedExampleCount: 0,
    });
    expect(weak).toBeGreaterThan(0);
    expect(weak).toBeLessThan(0.25);
    // The distinguishing property: it must NOT be the uncomputed placeholder.
    expect(weak).not.toBe(0.5);
  });

  it("a topic with literally nothing still clears the floor and nothing more", () => {
    const bare = computeExamWeight({
      override: null,
      signalCount: 0,
      sourceCount: 0,
      recencyFactor: 0,
      formulaCount: 0,
      workedExampleCount: 0,
    });
    expect(bare).toBe(EXAM_WEIGHT_FLOOR);
  });

  it("stays within [0, 1] under maximal load", () => {
    const loud = computeExamWeight({
      override: null,
      signalCount: 50,
      sourceCount: 50,
      recencyFactor: 1,
      formulaCount: 50,
      workedExampleCount: 50,
    });
    expect(loud).toBeGreaterThan(0.9);
    expect(loud).toBeLessThanOrEqual(1);
  });
});

describe("computeExamWeight — coverage recency (§9b)", () => {
  it("a fresh source outweighs a stale one, breadth held equal", () => {
    const stale = computeExamWeight({ ...MODERATE, signalCount: 0, recencyFactor: 0 });
    const fresh = computeExamWeight({ ...MODERATE, signalCount: 0, recencyFactor: 1 });
    expect(fresh).toBeGreaterThan(stale);
  });
});
