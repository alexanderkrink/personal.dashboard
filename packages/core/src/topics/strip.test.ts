import { describe, expect, it } from "vitest";
import type { TopicPageLike } from "./page";
import { planDocumentStrip, stripDocumentFromPage } from "./strip";

const DOC = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

/** A note block sourced by the given document ids. */
function note(id: string, ...documentIds: readonly string[]) {
  return {
    id,
    heading: id,
    markdown: `body of ${id}`,
    sources: documentIds.map((documentId) => ({ documentId, page: 1 })),
  };
}

describe("stripDocumentFromPage", () => {
  it("removes a block whose only source is this document", () => {
    const page: TopicPageLike = { notes: [note("a", DOC)] };
    const result = stripDocumentFromPage({ page, documentId: DOC });

    expect(result.page.notes).toEqual([]);
    expect(result.removedTotal).toBe(1);
    expect(result.removed.notes).toBe(1);
    expect(result.changed).toBe(true);
  });

  it("keeps a block another document also sources, and prunes only our provenance", () => {
    const page: TopicPageLike = { notes: [note("shared", DOC, OTHER)] };
    const result = stripDocumentFromPage({ page, documentId: DOC });

    expect(result.removedTotal).toBe(0);
    expect(result.page.notes).toHaveLength(1);
    // The block survives on the other document's account; our entry comes off its sources.
    expect(result.page.notes?.[0]?.sources).toEqual([{ documentId: OTHER, page: 1 }]);
    expect(result.changed).toBe(true);
  });

  it("leaves another document's blocks completely alone", () => {
    const page: TopicPageLike = { notes: [note("theirs", OTHER)] };
    const result = stripDocumentFromPage({ page, documentId: DOC });

    expect(result.page.notes).toEqual(page.notes);
    expect(result.changed).toBe(false);
  });

  it("keeps and counts a block with no sources at all", () => {
    const page: TopicPageLike = { notes: [{ id: "orphan", markdown: "x", sources: [] }] };
    const result = stripDocumentFromPage({ page, documentId: DOC });

    expect(result.removedTotal).toBe(0);
    expect(result.unattributedKept).toBe(1);
    expect(result.page.notes).toHaveLength(1);
    expect(result.changed).toBe(false);
  });

  it("keeps and counts a block whose sources carry no documentId", () => {
    const page: TopicPageLike = { notes: [{ id: "n", sources: [{ page: 3 }] }] };
    const result = stripDocumentFromPage({ page, documentId: DOC });

    expect(result.unattributedKept).toBe(1);
    expect(result.page.notes).toHaveLength(1);
  });

  it("keeps a block that mixes our source with an unattributed one", () => {
    // Conservative by design: we cannot prove the nameless entry is ours, so the block stays.
    const page: TopicPageLike = {
      notes: [{ id: "n", sources: [{ documentId: DOC, page: 1 }, { page: 2 }] }],
    };
    const result = stripDocumentFromPage({ page, documentId: DOC });

    expect(result.removedTotal).toBe(0);
    expect(result.unattributedKept).toBe(1);
    expect(result.page.notes).toHaveLength(1);
  });

  it("strips every block family, not just notes", () => {
    const page: TopicPageLike = {
      notes: [note("n", DOC)],
      keyTerms: [{ term: "t", definition: "d", sources: [{ documentId: DOC }] }],
      formulas: [{ name: "f", latex: "x", sources: [{ documentId: DOC }] }],
      workedExamples: [{ problem: "p", solution: "s", sources: [{ documentId: DOC }] }],
      openQuestions: [{ question: "q", sources: [{ documentId: DOC }] }],
    };
    const result = stripDocumentFromPage({ page, documentId: DOC });

    expect(result.removedTotal).toBe(5);
    expect(result.removed).toEqual({
      notes: 1,
      keyTerms: 1,
      formulas: 1,
      workedExamples: 1,
      openQuestions: 1,
    });
    expect(result.page.notes).toEqual([]);
    expect(result.page.keyTerms).toEqual([]);
    expect(result.page.formulas).toEqual([]);
    expect(result.page.workedExamples).toEqual([]);
    expect(result.page.openQuestions).toEqual([]);
  });

  it("never fabricates keys a page did not have", () => {
    // `topics.page` is `jsonb not null default '{}'` — a bare page must come back bare.
    const result = stripDocumentFromPage({ page: {}, documentId: DOC });

    expect(Object.keys(result.page)).toEqual([]);
    expect(result.changed).toBe(false);
  });

  it("preserves a page key it does not know about", () => {
    // `topics.page` is jsonb. A field added by a newer schema than this build must survive a
    // delete rather than being silently dropped by the round trip.
    const page = { notes: [note("a", DOC)], diagrams: [{ id: "d1" }] } as TopicPageLike;
    const result = stripDocumentFromPage({ page, documentId: DOC });

    expect((result.page as { diagrams?: unknown }).diagrams).toEqual([{ id: "d1" }]);
    expect(result.page.notes).toEqual([]);
  });

  it("preserves an explicit null rather than coercing it to an empty array", () => {
    const page: TopicPageLike = { notes: null };
    const result = stripDocumentFromPage({ page, documentId: DOC });

    expect(result.page.notes).toBeNull();
    expect("notes" in result.page).toBe(true);
  });

  it("flags a summary as possibly stale only when something was actually removed", () => {
    const withRemoval = stripDocumentFromPage({
      page: { summary: "About sampling.", notes: [note("a", DOC)] },
      documentId: DOC,
    });
    expect(withRemoval.summaryPossiblyStale).toBe(true);
    // The summary is carried across verbatim — it has no provenance to strip by.
    expect(withRemoval.page.summary).toBe("About sampling.");

    const withoutRemoval = stripDocumentFromPage({
      page: { summary: "About sampling.", notes: [note("a", OTHER)] },
      documentId: DOC,
    });
    expect(withoutRemoval.summaryPossiblyStale).toBe(false);
  });

  it("does not flag a blank summary as stale", () => {
    const result = stripDocumentFromPage({
      page: { summary: "   ", notes: [note("a", DOC)] },
      documentId: DOC,
    });
    expect(result.summaryPossiblyStale).toBe(false);
  });

  it("is idempotent — stripping twice is stripping once", () => {
    const page: TopicPageLike = {
      summary: "s",
      notes: [note("mine", DOC), note("shared", DOC, OTHER), note("theirs", OTHER)],
    };
    const once = stripDocumentFromPage({ page, documentId: DOC });
    const twice = stripDocumentFromPage({ page: once.page, documentId: DOC });

    expect(twice.page).toEqual(once.page);
    expect(twice.removedTotal).toBe(0);
    expect(twice.changed).toBe(false);
  });

  it("does not mutate the page it was given", () => {
    const page: TopicPageLike = { notes: [note("a", DOC), note("b", OTHER)] };
    const before = structuredClone(page);
    stripDocumentFromPage({ page, documentId: DOC });

    expect(page).toEqual(before);
  });
});

describe("planDocumentStrip", () => {
  it("removes a topic whose only source is this document", () => {
    // This is the shape of ALL live production data: topics created by a single document.
    const plan = planDocumentStrip({
      documentId: DOC,
      topics: [
        {
          topicId: "t1",
          title: "Statistics Fundamentals",
          page: { notes: [note("a", DOC)] },
          sourceDocumentIds: [DOC],
        },
      ],
    });

    expect(plan.verdicts).toEqual([
      { kind: "remove-topic", topicId: "t1", title: "Statistics Fundamentals" },
    ]);
    expect(plan.topicsRemoved).toBe(1);
    expect(plan.topicsRewritten).toBe(0);
    // Blocks inside a removed topic are not counted as "removed from a surviving page".
    expect(plan.blocksRemoved).toBe(0);
  });

  it("rewrites a topic that another document also feeds", () => {
    const plan = planDocumentStrip({
      documentId: DOC,
      topics: [
        {
          topicId: "t1",
          title: "Shared",
          page: { summary: "s", notes: [note("mine", DOC), note("theirs", OTHER)] },
          sourceDocumentIds: [DOC, OTHER],
        },
      ],
    });

    const verdict = plan.verdicts[0];
    expect(verdict?.kind).toBe("rewrite-page");
    if (verdict?.kind !== "rewrite-page") throw new Error("expected rewrite-page");

    expect(verdict.page.notes).toHaveLength(1);
    expect(verdict.page.notes?.[0]?.id).toBe("theirs");
    expect(plan.topicsRemoved).toBe(0);
    expect(plan.topicsRewritten).toBe(1);
    expect(plan.blocksRemoved).toBe(1);
    expect(plan.staleSummaries).toBe(1);
  });

  it("leaves a co-sourced topic unchanged when we contributed no attributable block", () => {
    const plan = planDocumentStrip({
      documentId: DOC,
      topics: [
        {
          topicId: "t1",
          title: "Untouched",
          page: { notes: [note("theirs", OTHER)] },
          sourceDocumentIds: [DOC, OTHER],
        },
      ],
    });

    expect(plan.verdicts[0]?.kind).toBe("unchanged");
    expect(plan.topicsRemoved).toBe(0);
    expect(plan.topicsRewritten).toBe(0);
  });

  it("counts unattributed survivors so the caller can admit to them", () => {
    const plan = planDocumentStrip({
      documentId: DOC,
      topics: [
        {
          topicId: "t1",
          title: "Mixed",
          page: {
            notes: [note("mine", DOC), { id: "nameless", sources: [] }, note("theirs", OTHER)],
          },
          sourceDocumentIds: [DOC, OTHER],
        },
      ],
    });

    expect(plan.blocksRemoved).toBe(1);
    expect(plan.blocksUnattributed).toBe(1);
  });

  it("handles a mixed set of topics in one pass", () => {
    const plan = planDocumentStrip({
      documentId: DOC,
      topics: [
        {
          topicId: "solo",
          title: "Solo",
          page: { notes: [note("a", DOC)] },
          sourceDocumentIds: [DOC],
        },
        {
          topicId: "shared",
          title: "Shared",
          page: { summary: "s", notes: [note("b", DOC), note("c", OTHER)] },
          sourceDocumentIds: [DOC, OTHER],
        },
        {
          topicId: "quiet",
          title: "Quiet",
          page: { notes: [note("d", OTHER)] },
          sourceDocumentIds: [DOC, OTHER],
        },
      ],
    });

    expect(plan.topicsRemoved).toBe(1);
    expect(plan.topicsRewritten).toBe(1);
    expect(plan.blocksRemoved).toBe(1);
    expect(plan.staleSummaries).toBe(1);
    expect(plan.verdicts.map((v) => v.kind)).toEqual(["remove-topic", "rewrite-page", "unchanged"]);
  });

  it("treats a duplicated source row as one document", () => {
    // `topic_sources` is unique on (topic_id, document_id), but the planner must not depend
    // on that to decide "this document is the only source".
    const plan = planDocumentStrip({
      documentId: DOC,
      topics: [
        {
          topicId: "t1",
          title: "Solo",
          page: { notes: [note("a", DOC)] },
          sourceDocumentIds: [DOC, DOC],
        },
      ],
    });

    expect(plan.verdicts[0]?.kind).toBe("remove-topic");
  });

  it("returns an empty plan for a document that touched no topic", () => {
    const plan = planDocumentStrip({ documentId: DOC, topics: [] });

    expect(plan.verdicts).toEqual([]);
    expect(plan.topicsRemoved).toBe(0);
    expect(plan.topicsRewritten).toBe(0);
    expect(plan.blocksRemoved).toBe(0);
    expect(plan.blocksUnattributed).toBe(0);
    expect(plan.staleSummaries).toBe(0);
  });
});
