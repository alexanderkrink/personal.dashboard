import { describe, expect, it } from "vitest";
import { computeCoverage, coverageSummary, isGenuineSkipReason } from "./coverage";

/**
 * The coverage map's contract, with the emphasis where the risk is.
 *
 * The arithmetic is easy and mostly uninteresting. What these tests are really pinning is
 * the **defensive** behaviour: that an unaudited, empty, self-contradictory or outright
 * hostile `skipped[]` cannot produce a reassuring number. Every one of the cases below is a
 * way "100% covered" could be reached dishonestly, and each asserts that it is not.
 */

const pagesUpTo = (n: number): number[] => Array.from({ length: n }, (_, index) => index + 1);

describe("isGenuineSkipReason", () => {
  it("accepts the concrete reasons §4.1 asks for", () => {
    expect(isGenuineSkipReason("title slide")).toBe(true);
    expect(isGenuineSkipReason("bibliography")).toBe(true);
    expect(isGenuineSkipReason("duplicate of page 12")).toBe(true);
  });

  it("rejects the shapes of a reason that are not reasons", () => {
    for (const reason of ["", "  ", "-", "n/a", "none", "skipped", "other", "unknown", "ok"]) {
      expect(isGenuineSkipReason(reason)).toBe(false);
    }
  });
});

describe("computeCoverage — the honest case", () => {
  it("reports full coverage only when every page reached a topic", () => {
    const map = computeCoverage({
      sourceUnits: 10,
      extractedPages: pagesUpTo(10),
      mappedPages: pagesUpTo(10),
      topicCount: 3,
    });

    expect(map.checked).toBe(true);
    expect(map.pagesMapped).toBe(10);
    expect(map.pagesTotal).toBe(10);
    expect(map.pagesUndeclared).toBe(0);
    expect(map.trustworthy).toBe(true);
    expect(map.gaps).toEqual([]);
    expect(map.warnings).toEqual([]);
  });

  it("counts a credibly-declared skip as a gap with its reason, not as coverage", () => {
    const map = computeCoverage({
      sourceUnits: 10,
      extractedPages: pagesUpTo(10).filter((page) => page !== 1),
      skipped: [{ fromPage: 1, toPage: 1, reason: "title slide" }],
      mappedPages: pagesUpTo(10).filter((page) => page !== 1),
      topicCount: 2,
    });

    expect(map.pagesMapped).toBe(9);
    expect(map.pagesSkipped).toBe(1);
    expect(map.pagesUndeclared).toBe(0);
    expect(map.trustworthy).toBe(true);
    expect(map.gaps).toEqual([{ fromPage: 1, toPage: 1, kind: "skipped", reason: "title slide" }]);
  });

  it("distinguishes a page that was read but never cited from one never read at all", () => {
    const map = computeCoverage({
      sourceUnits: 4,
      extractedPages: [1, 2, 3],
      mappedPages: [1, 2],
      topicCount: 1,
    });

    expect(map.pagesUnmapped).toBe(1);
    expect(map.pagesUndeclared).toBe(1);
    expect(map.gaps).toEqual([
      { fromPage: 3, toPage: 3, kind: "unmapped", reason: "read, but no topic page cites it" },
      {
        fromPage: 4,
        toPage: 4,
        kind: "undeclared",
        reason: "not read and not declared skipped",
      },
    ]);
  });

  it("collapses consecutive gap pages into one clickable range", () => {
    const map = computeCoverage({
      sourceUnits: 10,
      extractedPages: [1, 2],
      mappedPages: [1, 2],
      topicCount: 1,
    });

    expect(map.gaps).toEqual([
      {
        fromPage: 3,
        toPage: 10,
        kind: "undeclared",
        reason: "not read and not declared skipped",
      },
    ]);
  });
});

describe("computeCoverage — an unreliable skipped[] cannot buy coverage", () => {
  it("does not report full coverage when skipped[] is empty but pages are missing", () => {
    // The exact silent-omission case: the model read 12 of 19 pages and declared nothing.
    const map = computeCoverage({
      sourceUnits: 19,
      extractedPages: pagesUpTo(12),
      skipped: [],
      mappedPages: pagesUpTo(12),
      topicCount: 4,
    });

    expect(map.pagesMapped).toBe(12);
    expect(map.pagesUndeclared).toBe(7);
    expect(map.trustworthy).toBe(false);
    expect(map.warnings.join(" ")).toContain("neither read nor declared skipped");
  });

  it("demotes a skip with no usable reason to undeclared loss", () => {
    const map = computeCoverage({
      sourceUnits: 5,
      extractedPages: [1, 2, 3],
      skipped: [{ fromPage: 4, toPage: 5, reason: "n/a" }],
      mappedPages: [1, 2, 3],
      topicCount: 1,
    });

    expect(map.pagesSkipped).toBe(0);
    expect(map.pagesUndeclared).toBe(2);
    expect(map.trustworthy).toBe(false);
    expect(map.gaps[0]?.kind).toBe("undeclared");
    expect(map.gaps[0]?.reason).toBe("reported skipped without a usable reason");
    expect(map.warnings.join(" ")).toContain("no usable reason");
  });

  it("flags an implausibly large declared skip even when every reason is well-formed", () => {
    // The measured corpus: 8 of 19 pages declared skipped, all with tidy reasons.
    const map = computeCoverage({
      sourceUnits: 19,
      extractedPages: pagesUpTo(11),
      skipped: [{ fromPage: 12, toPage: 19, reason: "bibliography and appendices" }],
      mappedPages: pagesUpTo(11),
      topicCount: 3,
    });

    expect(map.pagesSkipped).toBe(8);
    expect(map.pagesUndeclared).toBe(0);
    expect(map.trustworthy).toBe(false);
    expect(map.warnings.join(" ")).toContain("a large share for one document");
  });

  it("deduplicates overlapping skipped ranges instead of over-accounting", () => {
    const map = computeCoverage({
      sourceUnits: 10,
      extractedPages: [1, 2, 3, 4, 5, 6, 7],
      skipped: [
        { fromPage: 8, toPage: 10, reason: "appendix" },
        { fromPage: 8, toPage: 10, reason: "appendix" },
        { fromPage: 9, toPage: 10, reason: "index" },
      ],
      mappedPages: [1, 2, 3, 4, 5, 6, 7],
      topicCount: 2,
    });

    expect(map.pagesSkipped).toBe(3);
    expect(map.pagesMapped + map.pagesSkipped).toBe(10);
  });

  it("discards a skipped range that lies outside the document", () => {
    const map = computeCoverage({
      sourceUnits: 5,
      extractedPages: pagesUpTo(5),
      skipped: [{ fromPage: 40, toPage: 60, reason: "appendix" }],
      mappedPages: pagesUpTo(5),
      topicCount: 1,
    });

    expect(map.pagesSkipped).toBe(0);
    expect(map.pagesMapped).toBe(5);
    expect(map.warnings.join(" ")).toContain("lies outside this 5-page document");
  });

  it("refuses to count a page as both extracted and skipped", () => {
    const map = computeCoverage({
      sourceUnits: 3,
      extractedPages: [1, 2, 3],
      skipped: [{ fromPage: 2, toPage: 2, reason: "agenda" }],
      mappedPages: [1, 2, 3],
      topicCount: 1,
    });

    expect(map.pagesSkipped).toBe(0);
    expect(map.pagesMapped).toBe(3);
  });

  it("ignores a malformed range rather than letting it distort the arithmetic", () => {
    const map = computeCoverage({
      sourceUnits: 4,
      extractedPages: pagesUpTo(4),
      skipped: [{ fromPage: 0, toPage: -3, reason: "front matter" }],
      mappedPages: pagesUpTo(4),
      topicCount: 1,
    });

    expect(map.pagesSkipped).toBe(0);
    expect(map.warnings.join(" ")).toContain("was not a page range");
  });

  it("accepts an inverted range by normalising it", () => {
    const map = computeCoverage({
      sourceUnits: 6,
      extractedPages: [1, 2, 3],
      skipped: [{ fromPage: 6, toPage: 4, reason: "bibliography" }],
      mappedPages: [1, 2, 3],
      topicCount: 1,
    });

    expect(map.pagesSkipped).toBe(3);
    expect(map.pagesUndeclared).toBe(0);
  });
});

describe("computeCoverage — phantom citations cannot inflate coverage", () => {
  it("does not count a topic citation past the end of the document", () => {
    const map = computeCoverage({
      sourceUnits: 5,
      extractedPages: pagesUpTo(5),
      mappedPages: [1, 2, 3, 4, 5, 400],
      topicCount: 2,
    });

    expect(map.pagesMapped).toBe(5);
    expect(map.warnings.join(" ")).toContain("point past the end");
  });

  it("ignores non-integer and zero page numbers from either side", () => {
    const map = computeCoverage({
      sourceUnits: 3,
      extractedPages: [1, 2, 3, 0, 2.5],
      mappedPages: [1, 2, 3, -1],
      topicCount: 1,
    });

    expect(map.pagesMapped).toBe(3);
    expect(map.pagesTotal).toBe(3);
  });
});

describe("computeCoverage — no denominator means no claim", () => {
  it("marks the map unchecked and untrustworthy when sourceUnits is unknown", () => {
    const map = computeCoverage({
      extractedPages: pagesUpTo(8),
      mappedPages: pagesUpTo(8),
      topicCount: 2,
    });

    expect(map.checked).toBe(false);
    expect(map.trustworthy).toBe(false);
    expect(map.warnings.join(" ")).toContain("could not be established independently");
  });

  it("treats a zero page count as unknown rather than as an empty document", () => {
    const map = computeCoverage({
      sourceUnits: 0,
      extractedPages: [1, 2],
      mappedPages: [1, 2],
      topicCount: 1,
    });

    expect(map.checked).toBe(false);
  });

  it("computes no gaps at all when it has no page range to compute them over", () => {
    const map = computeCoverage({
      extractedPages: [],
      mappedPages: [],
      topicCount: 0,
    });

    expect(map.gaps).toEqual([]);
    expect(map.pagesTotal).toBe(0);
    expect(map.checked).toBe(false);
  });
});

describe("computeCoverage — syllabus objectives", () => {
  it("carries missing objectives through onto the map", () => {
    const map = computeCoverage({
      sourceUnits: 3,
      extractedPages: pagesUpTo(3),
      mappedPages: pagesUpTo(3),
      topicCount: 1,
      missingObjectives: ["Explain price discrimination", "Compute consumer surplus"],
    });

    expect(map.missingObjectives).toEqual([
      "Explain price discrimination",
      "Compute consumer surplus",
    ]);
    // Missing objectives are an importance signal, not a page-coverage defect: they do not
    // by themselves make the page arithmetic untrustworthy.
    expect(map.trustworthy).toBe(true);
  });

  it("defaults to an empty list rather than undefined", () => {
    const map = computeCoverage({
      sourceUnits: 1,
      extractedPages: [1],
      mappedPages: [1],
      topicCount: 1,
    });
    expect(map.missingObjectives).toEqual([]);
  });
});

describe("coverageSummary", () => {
  it("renders §8's sentence for a fully covered document", () => {
    const map = computeCoverage({
      sourceUnits: 24,
      extractedPages: pagesUpTo(24),
      mappedPages: pagesUpTo(24),
      topicCount: 4,
    });

    expect(coverageSummary(map)).toBe("24 of 24 pages mapped across 4 topics");
  });

  it("names the gaps and their reasons", () => {
    const map = computeCoverage({
      sourceUnits: 600,
      extractedPages: pagesUpTo(587),
      skipped: [{ fromPage: 588, toPage: 600, reason: "index" }],
      mappedPages: pagesUpTo(587),
      topicCount: 24,
    });

    const summary = coverageSummary(map);
    expect(summary).toContain("587 of 600 pages mapped across 24 topics");
    // These 13 pages were DECLARED SKIPPED, and until Wave 5 the sentence called them
    // "unmapped" — the same conflation that made the Wave 4 document read "53 unmapped"
    // when 47 were unmapped and 6 were deliberately skipped. Each gap is now named as
    // itself; PLAN §8's example sentence has the older, looser wording.
    expect(summary).toContain("13 skipped");
    expect(summary).not.toContain("13 unmapped");
    expect(summary).toContain("index");
  });

  it("calls out undeclared pages separately, because they are the dangerous ones", () => {
    const map = computeCoverage({
      sourceUnits: 19,
      extractedPages: pagesUpTo(12),
      mappedPages: pagesUpTo(12),
      topicCount: 4,
    });

    expect(coverageSummary(map)).toContain("7 unaccounted for");
  });

  it("refuses to state a ratio when the document's length could not be verified", () => {
    const map = computeCoverage({
      extractedPages: pagesUpTo(8),
      mappedPages: pagesUpTo(8),
      topicCount: 2,
    });

    const summary = coverageSummary(map);
    expect(summary).toContain("coverage is unknown");
    expect(summary).not.toContain(" of ");
    expect(summary).not.toContain("%");
  });

  it("uses singular wording for a one-topic, one-page document", () => {
    const map = computeCoverage({
      sourceUnits: 1,
      extractedPages: [1],
      mappedPages: [1],
      topicCount: 1,
    });

    expect(coverageSummary(map)).toBe("1 of 1 pages mapped across 1 topic");
  });
});

/**
 * F4 — the mapped-ratio term in the trust predicate.
 *
 * Until Wave 5 `trustworthy` asked whether pages were *lost* and never whether pages
 * *arrived*. These tests are written against the real recorded numbers from the Wave 4
 * failure so the predicate is proven to discriminate, not merely to pass.
 */
describe("computeCoverage — the mapped ratio", () => {
  /** The exact shape of the Wave 4 failure: 54 pages, 6 skipped, 48 read, 1 cited. */
  const wave4 = {
    sourceUnits: 54,
    // Pages 2–53, less the four mid-document skips. 48 pages, exactly as recorded.
    extractedPages: Array.from({ length: 52 }, (_, i) => i + 2).filter(
      (p) => ![15, 16, 36, 43].includes(p),
    ),
    skipped: [
      { fromPage: 1, toPage: 1, reason: "title slide" },
      { fromPage: 15, toPage: 16, reason: "agenda and section transition slides" },
      { fromPage: 36, toPage: 36, reason: "section transition slide" },
      { fromPage: 43, toPage: 43, reason: "section transition slide" },
      { fromPage: 54, toPage: 54, reason: "copyright / legal slide" },
    ],
    topicCount: 1,
  };

  it("RED: the recorded Wave 4 output is NOT trustworthy under the new predicate", () => {
    const map = computeCoverage({ ...wave4, mappedPages: [2] });

    // This is the assertion the Wave 4 pipeline could not make. It shipped
    // `trustworthy: true, warnings: []` on exactly these numbers.
    expect(map.pagesMapped).toBe(1);
    expect(map.trustworthy).toBe(false);
    expect(map.warnings.join(" ")).toMatch(/cited by any topic/);
  });

  it("GREEN: the same document with every readable page cited is trustworthy", () => {
    const map = computeCoverage({ ...wave4, mappedPages: wave4.extractedPages, topicCount: 7 });

    expect(map.pagesMapped).toBe(wave4.extractedPages.length);
    expect(map.pagesUnmapped).toBe(0);
    expect(map.trustworthy).toBe(true);
  });

  it("holds the line at the threshold rather than near it", () => {
    // 48 mappable pages; 60% of 48 is 28.8, so 29 mapped passes and 28 does not.
    const at = computeCoverage({ ...wave4, mappedPages: wave4.extractedPages.slice(0, 29) });
    const below = computeCoverage({ ...wave4, mappedPages: wave4.extractedPages.slice(0, 28) });

    expect(at.trustworthy).toBe(true);
    expect(below.trustworthy).toBe(false);
  });

  it("does not punish a document whose pages were all legitimately skipped", () => {
    const map = computeCoverage({
      sourceUnits: 2,
      extractedPages: [],
      skipped: [{ fromPage: 1, toPage: 2, reason: "title slide" }],
      mappedPages: [],
      topicCount: 0,
    });

    // Nothing was mappable, so the ratio is vacuous — the skip ratio is the check that
    // owns this document, and it fires on its own terms.
    expect(map.warnings.join(" ")).not.toMatch(/cited by any topic/);
  });
});
