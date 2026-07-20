import { describe, expect, it } from "vitest";
import { detectMergeLoss, type LossDetectorInput } from "./loss-detector";
import type { TopicPageLike } from "./page";

const DOC = "doc-7";

function note(id: string, markdown: string, pages: readonly number[] = [1]) {
  return {
    id,
    heading: id.replace(/-/g, " "),
    markdown,
    sources: pages.map((page) => ({ documentId: DOC, locator: { page } })),
  };
}

function page(overrides: Partial<TopicPageLike> = {}): TopicPageLike {
  return { summary: "s", notes: [], keyTerms: [], formulas: [], workedExamples: [], ...overrides };
}

/** Defaults describe a clean, fully-accounted document. Tests override only what they test. */
function input(overrides: Partial<LossDetectorInput>): LossDetectorInput {
  return {
    before: page(),
    after: page(),
    documentId: DOC,
    // Two pages, deliberately: below `MIN_ROUTED_FOR_CITATION_CHECK`, so the
    // citation-share check (5) is inert here and every test of it opts in explicitly.
    routedPages: [1, 2],
    unaccountedPages: [],
    coverageChecked: true,
    ...overrides,
  };
}

describe("detectMergeLoss — the dropped-block case", () => {
  it("red-flags a block that vanished with no declared removal", () => {
    const result = detectMergeLoss(
      input({
        before: page({ notes: [note("pricing-intro", "text"), note("elasticity", "text")] }),
        after: page({ notes: [note("elasticity", "text")] }),
        removals: [],
      }),
    );

    expect(result.hasRedFlag).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      kind: "undeclared-removal",
      severity: "red",
      subject: "note:pricing-intro",
    });
    expect(result.blocksBefore).toBe(2);
    expect(result.blocksAfter).toBe(1);
  });

  it("accepts the same removal once the merge declares it", () => {
    const result = detectMergeLoss(
      input({
        before: page({ notes: [note("pricing-intro", "text"), note("elasticity", "text")] }),
        after: page({ notes: [note("elasticity", "text")] }),
        removals: [{ blockKey: "note:pricing-intro", reason: "superseded by elasticity" }],
      }),
    );

    expect(result.findings).toEqual([]);
    expect(result.hasRedFlag).toBe(false);
  });

  it("does not flag a block that was merely edited", () => {
    const result = detectMergeLoss(
      input({
        before: page({ notes: [note("pricing-intro", "old text")] }),
        after: page({ notes: [note("pricing-intro", "old text, plus new material")] }),
      }),
    );

    expect(result.findings).toEqual([]);
  });

  /** Identity survives cosmetic heading edits — otherwise every tidy-up is a red flag. */
  it("treats a re-capitalised key term as the same block", () => {
    const result = detectMergeLoss(
      input({
        before: page({ keyTerms: [{ term: "Price Elasticity", definition: "d", sources: [] }] }),
        after: page({ keyTerms: [{ term: "price elasticity.", definition: "d2", sources: [] }] }),
      }),
    );

    expect(result.findings).toEqual([]);
  });

  it("red-flags every block when the proposed page came back empty", () => {
    const result = detectMergeLoss(
      input({
        before: page({
          notes: [note("a", "x"), note("b", "y")],
          keyTerms: [{ term: "Margin", definition: "d", sources: [] }],
        }),
        after: {},
      }),
    );

    expect(result.findings).toHaveLength(3);
    expect(result.hasRedFlag).toBe(true);
  });

  it("red-flags a block kept in name but emptied of content", () => {
    const result = detectMergeLoss(
      input({
        before: page({ notes: [note("pricing-intro", "a paragraph of real notes")] }),
        after: page({ notes: [note("pricing-intro", "")] }),
      }),
    );

    expect(result.findings[0]).toMatchObject({ kind: "emptied-block", severity: "red" });
  });

  it("reports a removal declared for a block that never existed, but only as amber", () => {
    const result = detectMergeLoss(
      input({ removals: [{ blockKey: "note:ghost", reason: "superseded" }] }),
    );

    expect(result.findings[0]).toMatchObject({ kind: "phantom-removal", severity: "amber" });
    expect(result.hasRedFlag).toBe(false);
  });

  /**
   * openQuestions are the merge's OUTPUT under the conflict rule, so their coming and going
   * is the pipeline working. Flagging it would fire on every correctly-merged conflict.
   */
  it("ignores openQuestions entirely", () => {
    const result = detectMergeLoss(
      input({
        before: page({
          openQuestions: [{ question: "q", context: "c", kind: "conflict", sources: [] }],
        }),
        after: page({ openQuestions: [] }),
      }),
    );

    expect(result.findings).toEqual([]);
  });
});

describe("detectMergeLoss — the phantom-locator case", () => {
  it("red-flags a citation of a page no routed segment covers", () => {
    const result = detectMergeLoss(
      input({
        after: page({ notes: [note("new-block", "text", [14])] }),
        routedPages: [1, 2],
      }),
    );

    expect(result.hasRedFlag).toBe(true);
    expect(result.findings[0]).toMatchObject({
      kind: "phantom-locator",
      severity: "red",
      subject: "note:new-block@14",
    });
  });

  it("accepts a citation inside the routed pages", () => {
    const result = detectMergeLoss(
      input({ after: page({ notes: [note("new-block", "text", [2])] }), routedPages: [1, 2] }),
    );

    expect(result.findings).toEqual([]);
  });

  it("does not police citations of OTHER documents", () => {
    const result = detectMergeLoss(
      input({
        after: page({
          notes: [
            {
              id: "carried",
              heading: "h",
              markdown: "m",
              // A block inherited from an earlier document keeps its own provenance, and
              // this document's routed pages say nothing about whether it is valid.
              sources: [{ documentId: "doc-1", locator: { page: 99 } }],
            },
          ],
        }),
      }),
    );

    expect(result.findings).toEqual([]);
  });

  it("skips document-level citations that name no page", () => {
    const result = detectMergeLoss(
      input({
        after: page({
          notes: [
            { id: "x", heading: "h", markdown: "m", sources: [{ documentId: DOC, locator: {} }] },
          ],
        }),
      }),
    );

    expect(result.findings).toEqual([]);
  });

  /**
   * The shape the live schema actually emits. `blockSourceSchema` was flattened from
   * `{documentId, locator:{page,slide}}` to `{documentId, page}` after Anthropic refused
   * the nested version with "the compiled grammar is too large" — so the flat form is what
   * every real merge produces and it must be the form the detector reads first.
   */
  it("reads the flat `page` the live schema emits", () => {
    const result = detectMergeLoss(
      input({
        after: page({
          notes: [
            { id: "x", heading: "h", markdown: "m", sources: [{ documentId: DOC, page: 14 }] },
          ],
        }),
        routedPages: [1, 2],
      }),
    );

    expect(result.findings[0]).toMatchObject({ kind: "phantom-locator", subject: "note:x@14" });
  });

  it("accepts a flat citation inside the routed pages", () => {
    const result = detectMergeLoss(
      input({
        after: page({
          notes: [
            { id: "x", heading: "h", markdown: "m", sources: [{ documentId: DOC, page: 2 }] },
          ],
        }),
      }),
    );

    expect(result.findings).toEqual([]);
  });

  it("reads a slide locator the same way as a page locator", () => {
    const result = detectMergeLoss(
      input({
        after: page({
          notes: [
            {
              id: "x",
              heading: "h",
              markdown: "m",
              sources: [{ documentId: DOC, locator: { slide: 9 } }],
            },
          ],
        }),
        routedPages: [1, 2],
      }),
    );

    expect(result.findings[0]).toMatchObject({ kind: "phantom-locator", subject: "note:x@9" });
  });

  /**
   * The defensive case, and the reason `unaccountedPages` is threaded through at all.
   *
   * `skipped[]` is unaudited and extractions have silently dropped pages. A merger citing
   * page 14 of a document whose page 14 vanished from the extraction is not hallucinating —
   * the evidence is missing. Reporting that as fabrication sends the investigation the
   * wrong way, so it degrades to amber and says why.
   */
  it("downgrades to unverifiable when the extraction lost pages undeclared", () => {
    const result = detectMergeLoss(
      input({
        after: page({ notes: [note("new-block", "text", [14])] }),
        routedPages: [1, 2],
        unaccountedPages: [14],
      }),
    );

    expect(result.findings[0]).toMatchObject({
      kind: "unverifiable-locator",
      severity: "amber",
    });
    expect(result.hasRedFlag).toBe(false);
  });

  it("downgrades when coverage could not be computed at all", () => {
    const result = detectMergeLoss(
      input({
        after: page({ notes: [note("new-block", "text", [14])] }),
        coverageChecked: false,
      }),
    );

    expect(result.findings[0]?.kind).toBe("unverifiable-locator");
  });

  it("reports one finding per (block, locator) rather than per citation", () => {
    const result = detectMergeLoss(
      input({
        after: page({ notes: [note("new-block", "text", [14, 14, 15])] }),
        routedPages: [1],
      }),
    );

    expect(result.findings.map((finding) => finding.subject)).toEqual([
      "note:new-block@14",
      "note:new-block@15",
    ]);
  });
});

describe("detectMergeLoss — a clean merge", () => {
  it("returns nothing for a merge that integrated new material correctly", () => {
    const result = detectMergeLoss(
      input({
        before: page({
          notes: [note("intro", "the original paragraph", [])],
          keyTerms: [{ term: "Margin", definition: "old", sources: [] }],
        }),
        after: page({
          notes: [
            note("intro", "the original paragraph, extended with session 7 material", [2]),
            note("new-section", "genuinely new material", [3]),
          ],
          keyTerms: [{ term: "Margin", definition: "old, sharpened", sources: [] }],
        }),
        removals: [],
        routedPages: [1, 2, 3],
      }),
    );

    expect(result.findings).toEqual([]);
    expect(result.hasRedFlag).toBe(false);
    expect(result.blocksBefore).toBe(2);
    expect(result.blocksAfter).toBe(3);
  });

  /**
   * ⚠ This test used to assert `findings` was empty for a first merge that cited one of
   * three routed pages, and in doing so it PINNED THE CREATE PATH AS UNCHECKED.
   *
   * Checks 1–3 all iterate `before`, which on a create is `EMPTY_TOPIC_PAGE` and flattens to
   * zero blocks — so all three loops run over an empty set and cannot produce a finding no
   * matter how bad the merge is. Check 4 skips any unit already in `routedPages`, so it
   * cannot see uncited pages either. A green test over that combination reads as "the create
   * path is verified" when nothing whatsoever was verified, which is precisely how Wave 4
   * shipped a page built from 1 of 48 routed pages with no finding against it.
   */
  it("does not flag a first merge that cites what it was given", () => {
    const result = detectMergeLoss(
      input({
        before: {},
        after: page({ notes: [note("first", "content", [1, 2, 3])] }),
        routedPages: [1, 2, 3],
      }),
    );

    expect(result.findings).toEqual([]);
  });

  it("RED: flags a first merge that cites one of the three pages it was given", () => {
    const result = detectMergeLoss(
      input({
        before: {},
        after: page({ notes: [note("first", "content", [1])] }),
        routedPages: [1, 2, 3],
      }),
    );

    expect(result.hasRedFlag).toBe(true);
    expect(result.findings[0]).toMatchObject({ kind: "uncited-routed-pages", severity: "red" });
    expect(result.findings[0]?.detail).toContain("2, 3");
  });

  it("RED: flags the Wave 4 shape — 48 pages routed, one cited", () => {
    const routedPages = Array.from({ length: 48 }, (_, i) => i + 2);
    const result = detectMergeLoss(
      input({
        before: {},
        after: page({ notes: [note("objectives", "content", [2])] }),
        routedPages,
      }),
    );

    expect(result.hasRedFlag).toBe(true);
    expect(result.findings[0]).toMatchObject({
      kind: "uncited-routed-pages",
      subject: "47 of 48 pages",
    });
  });

  it("does not run the citation-share check on an UPDATE", () => {
    // The page is mostly prior material, so a low share against one document's contribution
    // is not evidence of anything.
    const result = detectMergeLoss(
      input({
        before: page({ notes: [note("existing", "old", [1])] }),
        after: page({ notes: [note("existing", "old and new", [1])] }),
        routedPages: [1, 2, 3],
      }),
    );

    expect(result.findings).toEqual([]);
  });

  it("does not run the citation-share check below three routed pages", () => {
    const result = detectMergeLoss(
      input({
        before: {},
        after: page({ notes: [note("first", "content", [1])] }),
        routedPages: [1, 2],
      }),
    );

    expect(result.findings).toEqual([]);
  });
});
