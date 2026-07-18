import { describe, expect, it } from "vitest";
import {
  sumWeightPercent,
  WEIGHT_TOTAL_TARGET,
  weightTotalDelta,
  weightTotalVerdict,
} from "./assessment-weights";

describe("sumWeightPercent", () => {
  it("returns 0 for no components", () => {
    expect(sumWeightPercent([])).toBe(0);
  });

  it("sums a syllabus that adds up", () => {
    expect(sumWeightPercent([40, 30, 20, 10])).toBe(100);
  });

  it("sums in hundredths, so float drift never reaches the caller", () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE 754.
    expect(sumWeightPercent([0.1, 0.2])).toBe(0.3);
    // Three thirds of a syllabus, as a lecturer would actually write them.
    expect(sumWeightPercent([33.33, 33.33, 33.34])).toBe(100);
    expect(sumWeightPercent([16.67, 16.67, 16.66, 50])).toBe(100);
  });
});

describe("weightTotalVerdict", () => {
  it("is 'empty' with no components, whatever the total says", () => {
    expect(weightTotalVerdict(0, 0)).toBe("empty");
    expect(weightTotalVerdict(100, 0)).toBe("empty");
  });

  it("is 'balanced' at exactly the target", () => {
    expect(weightTotalVerdict(WEIGHT_TOTAL_TARGET, 4)).toBe("balanced");
  });

  it("treats a hundredth either way as rounding, not a gap", () => {
    expect(weightTotalVerdict(99.99, 3)).toBe("balanced");
    expect(weightTotalVerdict(100.01, 3)).toBe("balanced");
  });

  it("flags a real gap in each direction", () => {
    expect(weightTotalVerdict(99.98, 3)).toBe("under");
    expect(weightTotalVerdict(100.02, 3)).toBe("over");
    expect(weightTotalVerdict(60, 2)).toBe("under");
    expect(weightTotalVerdict(130, 4)).toBe("over");
  });

  it("calls a course with one 0% component 'under', not 'empty'", () => {
    // The distinction matters: 'empty' teaches, 'under' warns.
    expect(weightTotalVerdict(0, 1)).toBe("under");
  });
});

describe("weightTotalDelta", () => {
  it("is signed, with over-weighting positive", () => {
    expect(weightTotalDelta(130)).toBe(30);
    expect(weightTotalDelta(60)).toBe(-40);
    expect(weightTotalDelta(100)).toBe(0);
  });

  it("reports the small gap a real syllabus leaves, without float noise", () => {
    // What `sumWeightPercent([33.33, 33.33, 33.33])` actually produces. The
    // naive `(total - 100)` here is -0.010000000000005116.
    expect(weightTotalDelta(sumWeightPercent([33.33, 33.33, 33.33]))).toBe(-0.01);
    expect(weightTotalDelta(100.01)).toBe(0.01);
  });
});
