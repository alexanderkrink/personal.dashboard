import { describe, expect, it } from "vitest";
import {
  analyseProvenance,
  COLLAPSE_MIN_CITATIONS,
  COLLAPSE_MIN_PAGES_AVAILABLE,
  type ProvenanceDocumentLike,
} from "./provenance";

const DOC = "2b33fe5b-0c05-4c15-9f56-d98cd3f00c31";

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** Stands in for the Wave 4 deck: 48 pages read, spanning 2–53. */
const deck: ProvenanceDocumentLike = {
  id: DOC,
  label: "Sampling Distributions",
  pagesRead: range(2, 49),
};

function note(id: string, pages: number[], documentId = DOC) {
  return {
    id,
    heading: id,
    markdown: `body of ${id}`,
    sources: pages.map((page) => ({ documentId, page })),
  };
}

describe("analyseProvenance — citation collapse", () => {
  /**
   * THE Wave 4 shape, reduced to its arithmetic: many blocks, many citations, one distinct
   * locator, a document read across dozens of pages. This is the assertion that fails if
   * the collapse detector is deleted or weakened, which is the whole reason the detector
   * exists.
   */
  it("flags a page whose every citation lands on one slide of a 48-page deck", () => {
    const report = analyseProvenance({
      page: {
        notes: range(1, 7).map((n) => note(`note-${n}`, [2])),
        keyTerms: range(1, 7).map((n) => ({
          term: `term ${n}`,
          definition: "d",
          sources: [{ documentId: DOC, page: 2 }],
        })),
        formulas: range(1, 6).map((n) => ({
          name: `formula ${n}`,
          latex: "x",
          explanation: "e",
          sources: [{ documentId: DOC, page: 2 }],
        })),
      },
      documents: [deck],
    });

    expect(report.citationCount).toBe(20);
    expect(report.distinctLocatorCount).toBe(1);
    expect(report.collapse).not.toBeNull();
    expect(report.collapse?.citationCount).toBe(20);
    expect(report.collapse?.pagesAvailable).toBe(48);
    expect(report.collapse?.detail).toContain("p. 2");
    expect(report.hasWeakness).toBe(true);
  });

  it("does not flag a page whose citations span the material", () => {
    const report = analyseProvenance({
      page: {
        notes: [note("a", [3, 4]), note("b", [11]), note("c", [27, 28]), note("d", [40])],
      },
      documents: [deck],
    });

    expect(report.collapse).toBeNull();
    expect(report.distinctLocatorCount).toBe(6);
    expect(report.hasWeakness).toBe(false);
  });

  it("does not cry collapse on a short page — under the citation floor", () => {
    const report = analyseProvenance({
      page: { notes: range(1, COLLAPSE_MIN_CITATIONS - 1).map((n) => note(`n${n}`, [2])) },
      documents: [deck],
    });
    expect(report.collapse).toBeNull();
  });

  it("does not cry collapse when there was barely anything to cite", () => {
    const tiny: ProvenanceDocumentLike = {
      id: DOC,
      label: "Handout",
      pagesRead: range(1, COLLAPSE_MIN_PAGES_AVAILABLE - 1),
    };
    const report = analyseProvenance({
      page: { notes: range(1, 6).map((n) => note(`n${n}`, [2])) },
      documents: [tiny],
    });
    expect(report.collapse).toBeNull();
  });
});

describe("analyseProvenance — block strength", () => {
  it("calls a block with no sources absent", () => {
    const report = analyseProvenance({
      page: { notes: [{ id: "orphan", heading: "Orphan", markdown: "x", sources: [] }] },
      documents: [deck],
    });
    expect(report.blocks[0]?.strength).toBe("absent");
    expect(report.blocksWithoutSources).toBe(1);
    expect(report.hasWeakness).toBe(true);
  });

  it("calls a block broken when its citation names a document that did not feed this topic", () => {
    const report = analyseProvenance({
      page: { notes: [note("ghost", [3], "11111111-1111-1111-1111-111111111111")] },
      documents: [deck],
    });
    expect(report.blocks[0]?.strength).toBe("broken");
    expect(report.blocks[0]?.citations[0]?.status).toBe("unknown-document");
    expect(report.blocks[0]?.citations[0]?.label).toContain("Unknown source");
    expect(report.brokenCitationCount).toBe(1);
  });

  /**
   * The case that makes a chip a lie rather than merely thin: the document is real, the
   * page number is real-looking, and the extractor never read that page — so following the
   * chip leads nowhere and nothing witnesses the claim.
   */
  it("calls a block broken when its citation names a page the extraction never read", () => {
    const report = analyseProvenance({
      page: { notes: [note("phantom", [400])] },
      documents: [deck],
    });
    expect(report.blocks[0]?.citations[0]?.status).toBe("unread-page");
    expect(report.blocks[0]?.strength).toBe("broken");
  });

  it("does not invent a defect when the pages read are unknown", () => {
    const report = analyseProvenance({
      page: { notes: [note("ok", [400])] },
      documents: [{ id: DOC, label: "Legacy upload", pagesRead: [] }],
    });
    expect(report.blocks[0]?.citations[0]?.status).toBe("resolved");
    expect(report.blocks[0]?.strength).toBe("single");
  });

  it("separates one location from several", () => {
    const report = analyseProvenance({
      page: { notes: [note("one", [3]), note("two", [3, 9])] },
      documents: [deck],
    });
    expect(report.blocks[0]?.strength).toBe("single");
    expect(report.blocks[1]?.strength).toBe("corroborated");
  });

  it("reads the legacy nested locator shape as well as the flat one", () => {
    const report = analyseProvenance({
      page: {
        notes: [
          {
            id: "legacy",
            heading: "Legacy",
            markdown: "x",
            sources: [{ documentId: DOC, locator: { page: 12 } }],
          },
        ],
      },
      documents: [deck],
    });
    expect(report.blocks[0]?.citations[0]?.page).toBe(12);
    expect(report.blocks[0]?.citations[0]?.status).toBe("resolved");
  });
});

describe("analyseProvenance — an empty page says nothing rather than something reassuring", () => {
  it("reports no weakness for a page with no blocks at all", () => {
    const report = analyseProvenance({ page: {}, documents: [deck] });
    expect(report.blocks).toHaveLength(0);
    expect(report.hasWeakness).toBe(false);
    expect(report.collapse).toBeNull();
  });

  it("flags a page that has content and no citations of any kind", () => {
    const report = analyseProvenance({
      page: { notes: [{ id: "a", heading: "A", markdown: "x" }] },
      documents: [deck],
    });
    expect(report.hasWeakness).toBe(true);
  });
});
