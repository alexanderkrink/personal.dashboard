import { describe, expect, it } from "vitest";
import {
  classifyPseudoRow,
  expandSessionRange,
  normalizeSummary,
  occurrenceLabel,
  stripJunk,
} from "./summary";

/** Narrows away the pseudo-row `null` so tests read straight. */
function normalize(raw: string, location?: string) {
  const result = normalizeSummary(raw, location === undefined ? {} : { location });
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

describe("🚨 the room echo — title must never be a room code", () => {
  /**
   * Regression for a defect that reached production data. §5.1b says the room
   * comes from `LOCATION`, never from `SUMMARY` "where it is duplicated" — but
   * the normalizer only declined to *read* it from `SUMMARY`, never *removed*
   * it. The room is the last field of the grammar, so on a clean row it was all
   * that survived and it became the title.
   *
   * Measured on the 374 live rows before the fix: 324 had `title` exactly equal
   * to `location`, 367 contained it, 305 were a bare `T-NN.NN`. Every class in
   * the calendar list rendered as `T-06.02`.
   */

  /** Real `(SUMMARY, LOCATION)` pairs, taken verbatim from the live feed. */
  const REAL_ROWS: ReadonlyArray<readonly [string, string | undefined, string]> = [
    // [raw summary, LOCATION, expected title]
    ["MARKETING MANAGEMENT    (Ses. 1) T-06.02", "T-06.02", ""],
    ["BUILDING POWERFUL RELATIONSHIPS    (Ses. 1-2) T-06.02", "T-06.02", ""],
    ["BUILDING POWERFUL RELATIONSHIPS   (Ses. 21) Asynchronous", "Asynchronous", ""],
    ["CORPORATE FINANCE    (Ses. 3) T-03.01", "T-03.01", ""],
    ["IE HUMANITIES   | | | , null, null (Ses. 4-5) T-06.04", "T-06.04", ""],
    ["DATA INSIGHTS AND VISUALIZATION   (Ses. 12) T-09.03A", "T-09.03A", ""],
    ["SOME COURSE   (Ses. 2) IE TOWER", "IE TOWER", ""],
    // Multi-room: the `|` is eaten by the junk stripper first, leaving two codes.
    ["DATA INSIGHTS AND VISUALIZATION    (Ses. 20) T-03.01|T-03.02", "T-03.01|T-03.02", ""],
    ["COMPUTATIONAL THINKING    (Ses. 30) T-12.02|T-12.03", "T-12.02|T-12.03", ""],
    // `Extra` is a real descriptor and survives; the room next to it does not.
    ["COST ACCOUNTING   Extra T-03.01", "T-03.01", "Extra"],
    ["FINANCE LAB   Extra Live online", "Live online", "Extra"],
    ["FINANCE LAB   Extra Asynchronous", "Asynchronous", "Extra"],
    // The 5 rows with NO `LOCATION` are the only ones carrying real prose, and
    // every one of them must survive untouched.
    ["IE HUMANITIES   Class Participation ", undefined, "Class Participation"],
    ["IE HUMANITIES   Final Exam - Session 30 ", undefined, "Final Exam - Session 30"],
    [
      "APPLIED BUSINESS MATHEMATICS   Final EXAM Retake June ABM30 ",
      undefined,
      "Final EXAM Retake June ABM30",
    ],
    [
      "CORPORATE FINANCE   Retake Exam Corporate Finance June 2026 ",
      undefined,
      "Retake Exam Corporate Finance June 2026",
    ],
    [
      "FINANCIAL ACCOUNTING   Retake Exam Financial Accounting June 2026 ",
      undefined,
      "Retake Exam Financial Accounting June 2026",
    ],
  ];

  it.each(REAL_ROWS)("normalizes %s", (raw, location, expected) => {
    expect(normalize(raw, location).title).toBe(expected);
  });

  it("never leaves a title equal to, or containing, the LOCATION", () => {
    for (const [raw, location] of REAL_ROWS) {
      if (location === undefined) continue;
      const { title } = normalize(raw, location);
      expect(title).not.toBe(location);
      for (const room of location.split("|")) {
        expect(title).not.toContain(room);
      }
    }
  });

  it("never leaves a bare room code, even when LOCATION is absent", () => {
    // 5 live rows carry a room in SUMMARY while LOCATION is null, so keying the
    // strip only on LOCATION would leave those behind.
    expect(normalize("ALGORITHMS & DATA STRUCTURES   Final Exam T-06.02").title).toBe("Final Exam");
    expect(normalize("SOME COURSE    (Ses. 9) T-20.04").title).toBe("");
  });

  it("does not eat the IE of a real course name", () => {
    // `IE TOWER` is stripped as a phrase; a bare /\bie\b/ would maul this row.
    const result = normalize("IE HUMANITIES   Class Participation ", undefined);
    expect(result.courseName).toBe("IE HUMANITIES");
    expect(result.title).toBe("Class Participation");
  });

  it("leaves rawSummary verbatim so the normalizer can be re-run", () => {
    const raw = "MARKETING MANAGEMENT    (Ses. 1) T-06.02";
    expect(normalize(raw, "T-06.02").rawSummary).toBe(raw);
  });

  it("still parses the session token it strips alongside the room", () => {
    const result = normalize("BUILDING POWERFUL RELATIONSHIPS    (Ses. 24-25) T-06.02", "T-06.02");
    expect(result.title).toBe("");
    expect(result.sessionFrom).toBe(24);
    expect(result.sessionTo).toBe(25);
  });
});

describe("occurrenceLabel — what the UI shows when title is legitimately empty", () => {
  it("prefers a real title", () => {
    expect(occurrenceLabel({ title: "Class Participation", sessionFrom: 3 })).toBe(
      "Class Participation",
    );
  });

  it("falls back to the session number", () => {
    expect(occurrenceLabel({ title: "", sessionFrom: 4, sessionTo: 4 })).toBe("Session 4");
  });

  it("renders a ranged session as a range", () => {
    expect(occurrenceLabel({ title: "", sessionFrom: 24, sessionTo: 25 })).toBe("Sessions 24–25");
  });

  it("falls back to the descriptor when there is no session either", () => {
    expect(occurrenceLabel({ title: "", descriptor: "final_exam" })).toBe("Final exam");
    expect(occurrenceLabel({ title: "", descriptor: "retake" })).toBe("Retake exam");
    expect(occurrenceLabel({ title: "", descriptor: "extra" })).toBe("Extra session");
  });

  it("never returns an empty string", () => {
    expect(occurrenceLabel({})).toBe("Class");
    expect(occurrenceLabel({ title: "   " })).toBe("Class");
    expect(occurrenceLabel({ title: null, sessionFrom: null, descriptor: null })).toBe("Class");
  });

  it("labels every real row without ever showing a room code", () => {
    // End-to-end over the live pairs: parse, then label.
    const rows = [
      ["MARKETING MANAGEMENT    (Ses. 1) T-06.02", "T-06.02", "Session 1"],
      ["BUILDING POWERFUL RELATIONSHIPS    (Ses. 1-2) T-06.02", "T-06.02", "Sessions 1–2"],
      ["BUILDING POWERFUL RELATIONSHIPS   (Ses. 21) Asynchronous", "Asynchronous", "Session 21"],
      ["COST ACCOUNTING   Extra T-03.01", "T-03.01", "Extra"],
      ["IE HUMANITIES   Class Participation ", undefined, "Class Participation"],
    ] as const;

    for (const [raw, location, expected] of rows) {
      const label = occurrenceLabel(normalize(raw, location));
      expect(label).toBe(expected);
      expect(label).not.toMatch(/T-\d{2}\.\d{2}/);
    }
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
