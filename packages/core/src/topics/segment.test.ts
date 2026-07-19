import { describe, expect, it } from "vitest";
import { type ExtractedPageLike, segmentExtraction } from "./segment";

function pages(from: number, to: number): ExtractedPageLike[] {
  const out: ExtractedPageLike[] = [];
  for (let n = from; n <= to; n += 1)
    out.push({ page: n, title: `Slide ${n}`, markdown: `body ${n}` });
  return out;
}

describe("segmentExtraction — boundaries", () => {
  it("starts a new segment at each heading at or above the level", () => {
    const result = segmentExtraction({
      pages: pages(1, 6),
      headings: [
        { text: "Introduction", level: 1, page: 1 },
        { text: "Elasticity", level: 2, page: 4 },
        // Level 3 is below the default cut and must NOT open a segment.
        { text: "A sub-point", level: 3, page: 5 },
      ],
    });

    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toMatchObject({ title: "Introduction", fromPage: 1, toPage: 3 });
    expect(result.segments[1]).toMatchObject({ title: "Elasticity", fromPage: 4, toPage: 6 });
  });

  it("falls back to fixed page runs when there are no headings", () => {
    const result = segmentExtraction({ pages: pages(1, 12), maxPagesPerSegment: 5 });

    expect(result.segments.map((segment) => segment.pages)).toEqual([
      [1, 2, 3, 4, 5],
      [6, 7, 8, 9, 10],
      [11, 12],
    ]);
    expect(result.segments[0]?.title).toBe("Pages 1–5");
  });

  /**
   * The case the run cap exists for: one heading on page 1 and forty pages under it would
   * otherwise produce a single segment and put the whole document into one routing decision
   * — the exact failure the heading branch was supposed to avoid, reached through it.
   */
  it("splits a long heading-delimited section by the run cap", () => {
    const result = segmentExtraction({
      pages: pages(1, 12),
      headings: [{ text: "Everything", level: 1, page: 1 }],
      maxPagesPerSegment: 5,
    });

    expect(result.segments).toHaveLength(3);
    expect(result.segments[0]?.title).toBe("Everything");
    // Continuation runs are page-labelled: they are not the heading's own opening section.
    expect(result.segments[1]?.title).toBe("Pages 6–10");
  });

  it("gives every segment a stable key across identical inputs", () => {
    const build = () => segmentExtraction({ pages: pages(1, 8), maxPagesPerSegment: 3 });
    expect(build().segments.map((s) => s.key)).toEqual(build().segments.map((s) => s.key));
    expect(build().segments.map((s) => s.key)).toEqual(["seg-1", "seg-2", "seg-3"]);
  });

  it("sorts out-of-order pages before segmenting", () => {
    const result = segmentExtraction({
      pages: [
        { page: 3, title: null, markdown: "c" },
        { page: 1, title: null, markdown: "a" },
        { page: 2, title: null, markdown: "b" },
      ],
    });

    expect(result.segments[0]?.pages).toEqual([1, 2, 3]);
  });

  it("carries the page number into the markdown so the merger can cite it", () => {
    const result = segmentExtraction({ pages: [{ page: 7, title: "Pricing", markdown: "body" }] });
    expect(result.segments[0]?.markdown).toBe("[p.7] Pricing\nbody");
  });

  it("returns no segments for an extraction with no pages", () => {
    const result = segmentExtraction({ pages: [] });
    expect(result.segments).toEqual([]);
    expect(result.extractedPages).toEqual([]);
  });
});

describe("segmentExtraction — coverage against an unaudited extraction", () => {
  it("reports nothing unaccounted when pages + skipped cover the source", () => {
    const result = segmentExtraction({
      pages: pages(1, 8),
      skipped: [{ fromPage: 9, toPage: 10, reason: "bibliography" }],
      sourceUnits: 10,
    });

    expect(result.coverageChecked).toBe(true);
    expect(result.declaredSkippedPages).toEqual([9, 10]);
    expect(result.unaccountedPages).toEqual([]);
  });

  /**
   * The measured case: extractions have returned 8 skipped pages of 19 and 6 of 22 with
   * nobody auditing the reasons. Pages in NEITHER list are undeclared loss, and this is the
   * number that makes it visible instead of inferred.
   */
  it("names the pages that are in neither `pages` nor `skipped`", () => {
    const result = segmentExtraction({
      pages: [...pages(1, 8), ...pages(12, 14)],
      skipped: [{ fromPage: 9, toPage: 9, reason: "agenda" }],
      sourceUnits: 14,
    });

    expect(result.unaccountedPages).toEqual([10, 11]);
  });

  it("says coverage was not checked when the source unit count is unknown", () => {
    const result = segmentExtraction({ pages: pages(1, 8) });

    expect(result.coverageChecked).toBe(false);
    // Empty, but meaningless — `coverageChecked` is what a caller must read first, and the
    // loss-detector treats "not checked" the same as "lossy" for exactly this reason.
    expect(result.unaccountedPages).toEqual([]);
  });

  it("expands and de-duplicates overlapping skipped ranges", () => {
    const result = segmentExtraction({
      pages: pages(1, 3),
      skipped: [
        { fromPage: 4, toPage: 6, reason: "a" },
        { fromPage: 5, toPage: 7, reason: "b" },
        // Reversed bounds still describe a real run; normalising beats rejecting.
        { fromPage: 9, toPage: 8, reason: "c" },
      ],
      sourceUnits: 9,
    });

    expect(result.declaredSkippedPages).toEqual([4, 5, 6, 7, 8, 9]);
    expect(result.unaccountedPages).toEqual([]);
  });
});
