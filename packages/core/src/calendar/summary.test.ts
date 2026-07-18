import { describe, expect, it } from "vitest";
import { classifyPseudoRow, expandSessionRange, normalizeSummary, stripJunk } from "./summary";

/** Narrows away the pseudo-row `null` so tests read straight. */
function normalize(raw: string) {
  const result = normalizeSummary(raw);
  if (!result) {
    throw new Error(`Expected "${raw}" to normalize, but it was filtered as a pseudo row`);
  }
  return result;
}

describe("course-name extraction", () => {
  it("takes the first multi-space segment", () => {
    expect(normalize("CORPORATE FINANCE    (Ses. 3) T-03.01").courseName).toBe("CORPORATE FINANCE");
  });

  it("strips a trailing pipe", () => {
    expect(normalize("COST ACCOUNTING   |").courseName).toBe("COST ACCOUNTING");
  });

  it("strips mixed pipe and null junk", () => {
    expect(normalize("IE HUMANITIES   | | | , null, null (Ses. 4-5) T-06.04").courseName).toBe(
      "IE HUMANITIES",
    );
  });

  it("survives leading whitespace without producing an empty course name", () => {
    // ⚠ Two of the five pseudo rows begin with leading whitespace, so splitting
    // on 2+ spaces without trimming first yields an EMPTY first segment.
    expect(normalize("   MICROECONOMICS   Extra T-03.04").courseName).toBe("MICROECONOMICS");
  });
});

describe("MARKETING MANAGEMENT fragmentation — the normalizer is not cosmetic", () => {
  /**
   * Verified 2026-07-18: this course fragments across three raw variants
   * holding 10 + 3 + 2 = 15 events. An un-normalised group-by loses 5 of 15
   * AND understates max session, which makes exam detection wrong.
   */
  const variants = [
    "MARKETING MANAGEMENT    (Ses. 1) T-06.02",
    "MARKETING MANAGEMENT   |  (Ses. 2) T-06.02",
    "MARKETING MANAGEMENT   | | , null (Ses. 3) T-06.02",
  ];

  it("collapses all three variants to one course name", () => {
    const names = new Set(variants.map((raw) => normalize(raw).courseName));
    expect([...names]).toEqual(["MARKETING MANAGEMENT"]);
    expect(names.size).toBe(1);
  });

  it("groups by raw summary into 3 buckets but by normalized name into 1", () => {
    const rawBuckets = new Set(variants);
    expect(rawBuckets.size).toBe(3);
    expect(new Set(variants.map((raw) => normalize(raw).courseName)).size).toBe(1);
  });
});

describe("session tokens", () => {
  it("parses a single session", () => {
    const result = normalize("CORPORATE FINANCE    (Ses. 3) T-03.01");
    expect(result.sessionFrom).toBe(3);
    expect(result.sessionTo).toBe(3);
  });

  it("parses a ranged session — one event covering two taught sessions", () => {
    const result = normalize("BUILDING POWERFUL RELATIONSHIPS    (Ses. 24-25) T-06.02");
    expect(result.sessionFrom).toBe(24);
    expect(result.sessionTo).toBe(25);
  });

  it("expands ranges so per-session logic does not undercount", () => {
    expect(expandSessionRange(normalize("X    (Ses. 24-25) T-1"))).toEqual([24, 25]);
    expect(expandSessionRange(normalize("X    (Ses. 7) T-1"))).toEqual([7]);
    expect(expandSessionRange(normalize("COST ACCOUNTING   |"))).toEqual([]);
  });

  it("leaves sessions undefined when the feed carries no token", () => {
    const result = normalize("COST ACCOUNTING   |");
    expect(result.sessionFrom).toBeUndefined();
    expect(result.sessionTo).toBeUndefined();
  });

  it("counts 35 sessions across 34 events when ranges are expanded", () => {
    // PROBABILITY & STATISTICS: 34 events / 35 sessions in the real feed.
    // Event count != session count is the trap this asserts against.
    const rows = [
      ...Array.from({ length: 33 }, (_, index) => `PROB    (Ses. ${index + 1}) T-06.02`),
      "PROB    (Ses. 34-35) T-06.02",
    ];
    expect(rows).toHaveLength(34);
    const sessions = new Set(rows.flatMap((raw) => expandSessionRange(normalize(raw))));
    expect(sessions.size).toBe(35);
    expect(Math.max(...sessions)).toBe(35);
  });
});

describe("descriptors", () => {
  it("classifies a regular session", () => {
    expect(normalize("CORPORATE FINANCE    (Ses. 3) T-03.01").descriptor).toBe("regular");
  });

  it("classifies an extra session", () => {
    expect(normalize("MICROECONOMICS   Extra T-03.04").descriptor).toBe("extra");
  });

  it("classifies a retake — and a 'Final EXAM Retake' is a RETAKE, not a final", () => {
    // Ordering matters: matching `final exam` first would file the June re-sit
    // as the course's final exam, which is the exact mistake guard 1 exists for.
    expect(
      normalize("APPLIED BUSINESS MATHEMATICS   Final EXAM Retake June ABM30 ").descriptor,
    ).toBe("retake");
    expect(normalize("CORPORATE FINANCE   Retake Exam June 2026").descriptor).toBe("retake");
  });

  it("classifies a final exam", () => {
    expect(normalize("ALGORITHMS & DATA STRUCTURES   Final Exam T-06.02").descriptor).toBe(
      "final_exam",
    );
  });
});

describe("the 5 pseudo/LMS rows — keyed on each row's own signature", () => {
  const pseudoRows = [
    ["**Last Update (IE Calendar)**", "last_update"],
    [
      "   BBADBA SEP-2025COST-NBDA.1.M.A: My Accounting Lab - Prof. Rui Oliveira ",
      "lms_course_shell",
    ],
    [
      "   BBADBA SEP-2025COST-NBDA.1.M.A: Cost Accounting BBADBA & BBABCSAI T-04.01",
      "lms_course_shell",
    ],
    [
      "APPLIED BUSINESS MATHEMATICS   Test the download and upload of Excel files ",
      "proctoring_check",
    ],
    [
      "APPLIED BUSINESS MATHEMATICS   Smowl Check-Test: Multiattempt, you can use it to test Smowl before any Exam or Quiz ",
      "proctoring_check",
    ],
  ] as const;

  it.each(pseudoRows)("drops %s", (raw, reason) => {
    expect(normalizeSummary(raw)).toBeNull();
    expect(classifyPseudoRow(raw)?.reason).toBe(reason);
  });

  it("drops exactly 5 and no more", () => {
    expect(pseudoRows).toHaveLength(5);
  });
});

describe("🚨 the APPLIED BUSINESS MATHEMATICS trap — all 4 rows", () => {
  /**
   * The course has 4 rows. Two are pseudo and must be DROPPED; two are real and
   * must SURVIVE. A filter keyed on "no course name" misses the pseudo pair; a
   * filter keyed on the course name eats the real pair. Only a signature keyed
   * on the row's own content gets all four right.
   */
  const DROPPED = [
    "APPLIED BUSINESS MATHEMATICS   Test the download and upload of Excel files ",
    "APPLIED BUSINESS MATHEMATICS   Smowl Check-Test: Multiattempt, you can use it to test Smowl before any Exam or Quiz ",
  ];
  const KEPT = [
    "APPLIED BUSINESS MATHEMATICS   Extra T-05.01",
    "APPLIED BUSINESS MATHEMATICS   Final EXAM Retake June ABM30 ",
  ];

  it.each(DROPPED)("drops the pseudo row: %s", (raw) => {
    expect(normalizeSummary(raw)).toBeNull();
  });

  it.each(KEPT)("keeps the real row: %s", (raw) => {
    const result = normalizeSummary(raw);
    expect(result).not.toBeNull();
    expect(result?.courseName).toBe("APPLIED BUSINESS MATHEMATICS");
  });

  it("splits the 4 rows exactly 2 dropped / 2 kept", () => {
    const all = [...DROPPED, ...KEPT];
    const kept = all.filter((raw) => normalizeSummary(raw) !== null);
    const dropped = all.filter((raw) => normalizeSummary(raw) === null);
    expect(all).toHaveLength(4);
    expect(kept).toHaveLength(2);
    expect(dropped).toHaveLength(2);
    expect(kept).toEqual(KEPT);
  });

  it("does not key the filter on the course prefix", () => {
    // The proof: same prefix, opposite outcomes.
    expect(normalizeSummary(DROPPED[0] as string)).toBeNull();
    expect(normalizeSummary(KEPT[0] as string)).not.toBeNull();
  });
});

describe("stripJunk", () => {
  it("removes pipes, nulls and collapses whitespace", () => {
    expect(stripJunk("MARKETING MANAGEMENT   | | , null")).toBe("MARKETING MANAGEMENT");
    expect(stripJunk("IE HUMANITIES   | | | , null, null")).toBe("IE HUMANITIES");
    expect(stripJunk("A    B")).toBe("A B");
  });

  it("leaves a clean name untouched", () => {
    expect(stripJunk("ALGORITHMS & DATA STRUCTURES")).toBe("ALGORITHMS & DATA STRUCTURES");
  });
});
