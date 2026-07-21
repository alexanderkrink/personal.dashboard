import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NeedsReviewChip } from "@/components/topic-page/grounding-banner";
import { READING_COLUMN_CLASS } from "@/components/topic-page/reading-layout";
import { TopicPageBody } from "@/components/topic-page/topic-page-body";
import {
  buildTopicView,
  type TopicDocumentRow,
  type TopicRevisionRow,
  type TopicRow,
  type TopicView,
} from "@/lib/topics/topic-view";
import { describeWithWave4Failure, loadWave4Failure } from "@/test/wave4-failure-fixture";

/**
 * The guard tests for every grounding affordance on the topic page.
 *
 * ## The structural point of this file
 *
 * Each affordance below is asserted **twice**: once against the real, frozen Wave 4 failure
 * — the artifact that shipped with twenty citations on one slide, 1 of 54 pages mapped and
 * `trustworthy: true` — and once against a well-grounded synthetic page. Both directions
 * are load-bearing. A test that only proves the warning appears on a fixture written to
 * make it appear proves nothing; a test that only proves it stays quiet on a good page
 * proves less. Deleting any affordance turns the first suite red, which is the property
 * that makes these guards rather than decoration.
 *
 * ⚠ The Wave 4 half is **real production data** and is gitignored — it is
 * `krinkk02@gmail.com`'s document, captured before Wave 5 touched anything. It is present
 * on Alexander's machine and absent in CI, so that suite *skips* rather than fails when the
 * corpus is missing. The well-grounded half is **synthetic**: no grounded topic page has
 * ever been produced by this pipeline, so there was nothing real to compare against.
 */

/* ────────────────────────────────────────────────────────────────────────── */
/* The synthetic well-grounded page                                           */
/* ────────────────────────────────────────────────────────────────────────── */

const GOOD_DOC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COURSE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOPIC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function pages(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, i) => ({
    page: from + i,
    title: `Slide ${from + i}`,
    markdown: "…",
  }));
}

/**
 * A page built the way the pipeline is supposed to build one: blocks citing the pages they
 * were actually written from, spread across the deck.
 */
function wellGroundedView(): TopicView {
  const topic: TopicRow = {
    id: TOPIC,
    course_id: COURSE,
    title: "Sampling Distributions",
    slug: "sampling-distributions",
    summary: "How sample statistics behave.",
    page: {
      summary: "How sample statistics behave across repeated samples.",
      notes: [
        {
          id: "why-sample",
          heading: "Why we sample",
          markdown: "We rarely observe a whole population.",
          sources: [{ documentId: GOOD_DOC, page: 3 }],
        },
        {
          id: "clt",
          heading: "The Central Limit Theorem",
          markdown: "For $n > 30$ the sampling distribution is approximately normal.",
          sources: [
            { documentId: GOOD_DOC, page: 18 },
            { documentId: GOOD_DOC, page: 19 },
          ],
        },
      ],
      keyTerms: [
        {
          term: "Standard error",
          definition: "The standard deviation of a sampling distribution.",
          sources: [{ documentId: GOOD_DOC, page: 12 }],
        },
      ],
      formulas: [
        {
          name: "Standard error of the mean",
          latex: "\\sigma_{\\bar{X}} = \\sigma / \\sqrt{n}",
          explanation: "Spread of the sample mean.",
          sources: [{ documentId: GOOD_DOC, page: 21 }],
        },
      ],
      workedExamples: [
        {
          problem: "A freezer holds packs with $\\sigma = 2.236$ and $n = 36$.",
          solution: "The standard error is $2.236/6 = 0.373$.",
          sources: [{ documentId: GOOD_DOC, page: 27 }],
        },
      ],
      openQuestions: [],
    },
    exam_weight: 0.5,
    exam_weight_override: null,
    revision: 2,
    updated_at: "2026-07-20T10:00:00Z",
  };

  const document: TopicDocumentRow = {
    id: GOOD_DOC,
    filename: "Sampling Distributions.pdf",
    session_label: "Lecture 7",
    kind: "slides",
    status: "ready",
    extraction_fidelity: "visual",
    failure_reason: null,
    coverage: {
      checked: true,
      pagesTotal: 30,
      pagesMapped: 27,
      pagesSkipped: 3,
      pagesUndeclared: 0,
      pagesUnmapped: 0,
      topicCount: 4,
      trustworthy: true,
      gaps: [{ fromPage: 1, toPage: 1, kind: "skipped", reason: "title slide" }],
      warnings: [],
      missingObjectives: [],
    },
    extraction: { extraction: { pages: pages(2, 30) } },
    failed_topics: [],
    created_at: "2026-07-20T09:00:00Z",
  };

  const revision: TopicRevisionRow = {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    revision: 1,
    page: { summary: "", notes: [], keyTerms: [], formulas: [], workedExamples: [] },
    change_summary: "Added the CLT block and the standard-error formula from Lecture 7.",
    source: "merge",
    needs_review: false,
    review_notes: [],
    document_id: GOOD_DOC,
    prompt_id: "topic-merge",
    prompt_version: 2,
    model: "claude-sonnet-5",
    created_at: "2026-07-20T10:00:00Z",
  };

  return buildTopicView({ topic, documents: [document], revisions: [revision] });
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The real Wave 4 artifact                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

function wave4View(): TopicView {
  const fixture = loadWave4Failure();

  const topic: TopicRow = {
    id: fixture.topic.id,
    course_id: fixture.topic.course_id,
    title: fixture.topic.title,
    slug: fixture.topic.slug,
    summary: fixture.topic.summary,
    page: fixture.topicPage,
    exam_weight: fixture.topic.exam_weight,
    exam_weight_override: fixture.topic.exam_weight_override,
    revision: fixture.topic.revision,
    updated_at: fixture.topic.updated_at,
  };

  const document: TopicDocumentRow = {
    id: fixture.document.id,
    filename: fixture.document.filename,
    session_label: fixture.document.session_label,
    kind: fixture.document.kind,
    status: fixture.document.status,
    extraction_fidelity: fixture.document.extraction_fidelity,
    failure_reason: fixture.document.failure_reason,
    coverage: fixture.coverage,
    extraction: { extraction: fixture.extraction },
    failed_topics: fixture.document.failed_topics,
    created_at: fixture.document.created_at,
  };

  // `topic_revisions` really is empty for this topic — that is one of the findings.
  return buildTopicView({ topic, documents: [document], revisions: [] });
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Guards — red against the artifact, green against the good page             */
/* ────────────────────────────────────────────────────────────────────────── */

describeWithWave4Failure("TopicPageBody — the real Wave 4 failure", () => {
  it("renders the page at all", () => {
    render(<TopicPageBody view={wave4View()} />);
    expect(screen.getByTestId("notes")).toBeInTheDocument();
    expect(screen.getByTestId("formulas")).toBeInTheDocument();
    expect(screen.getByTestId("key-terms")).toBeInTheDocument();
  });

  /**
   * GUARD 1 — the citation-collapse banner. Delete `CollapseBanner` or weaken
   * `detectCollapse` and this fails.
   */
  it("says at the top that every citation points at one page", () => {
    render(<TopicPageBody view={wave4View()} />);
    const banner = screen.getByText(/Every citation on this page points at one page/i);
    expect(banner).toBeInTheDocument();
    expect(
      screen.getByText(/All 20 citations on this page point at the same place/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/out of 48 pages that were read/i)).toBeInTheDocument();
  });

  /**
   * GUARD 2 — the coverage map's low-coverage state. `1 of 54 pages mapped · 47 unmapped ·
   * 6 skipped`, with the three counts named as three different things (the Wave 5
   * correction) and the whole disclosure marked poor.
   */
  it("shows 1-of-54 coverage as a poor state, counting unmapped and skipped separately", () => {
    render(<TopicPageBody view={wave4View()} />);
    const map = screen.getByTestId("coverage-map");
    expect(map.textContent).toContain("1 of 54 pages mapped");
    expect(map.textContent).toContain("47 unmapped");
    expect(map.textContent).toContain("6 skipped");
    expect(map.querySelector('[data-coverage-poor="true"]')).not.toBeNull();
    expect(
      screen.getByText(/Most of this document reached no topic page at all/i),
    ).toBeInTheDocument();
  });

  /**
   * GUARD 3 — the chips resolve to a real locator. Every one names the document by its
   * session label and the page it claims, and every one of them says page 2.
   */
  it("resolves every provenance chip to the same real locator", () => {
    const view = wave4View();
    render(<TopicPageBody view={view} />);

    const chips = screen.getAllByText("Chapter 6 · p. 2");
    expect(chips.length).toBe(20);

    // Resolved, not broken: page 2 really was read. The defect is that ONLY it was cited.
    for (const chip of chips) {
      expect(chip.getAttribute("data-citation-status")).toBe("resolved");
    }
    expect(view.provenance.distinctLocatorCount).toBe(1);
    expect(view.provenance.citationCount).toBe(20);
  });

  /**
   * GUARD 4 — the chip tells the reader what is actually on the page it points at. This is
   * the single most damning detail in the artifact: six formulas sourced to a slide titled
   * "Topic Goals".
   */
  it("names what is on the cited page, which is the objectives slide", () => {
    render(<TopicPageBody view={wave4View()} />);
    const chip = screen.getAllByText("Chapter 6 · p. 2")[0];
    expect(chip?.getAttribute("title")).toBe("On that page: Topic Goals");
  });

  /** GUARD 5 — `extraction_fidelity`, never rendered anywhere before this component. */
  it("states the extraction fidelity", () => {
    render(<TopicPageBody view={wave4View()} />);
    expect(screen.getByTestId("fidelity").textContent).toContain("read visually");
  });

  it("has no worked examples, because the merge produced none", () => {
    render(<TopicPageBody view={wave4View()} />);
    expect(screen.queryByTestId("worked-examples")).toBeNull();
  });
});

describe("TopicPageBody — a well-grounded page", () => {
  it("renders without any of the pathology affordances", () => {
    render(<TopicPageBody view={wellGroundedView()} />);

    expect(screen.queryByText(/Every citation on this page points at one page/i)).toBeNull();
    expect(screen.queryByText(/Some of this page has no source/i)).toBeNull();
    expect(screen.queryByText(/Most of this document reached no topic page/i)).toBeNull();
    expect(
      screen.getByTestId("coverage-map").querySelector('[data-coverage-poor="true"]'),
    ).toBeNull();
  });

  it("spreads its citations across the deck", () => {
    const view = wellGroundedView();
    render(<TopicPageBody view={view} />);

    expect(view.provenance.collapse).toBeNull();
    expect(view.provenance.distinctLocatorCount).toBe(6);
    expect(screen.getByText("Lecture 7 · p. 18")).toBeInTheDocument();
    expect(screen.getByText("Lecture 7 · p. 27")).toBeInTheDocument();
  });

  it("marks a corroborated block differently from a singly-sourced one", () => {
    const { container } = render(<TopicPageBody view={wellGroundedView()} />);
    expect(container.querySelector('[data-provenance="corroborated"]')).not.toBeNull();
    expect(container.querySelector('[data-provenance="single"]')).not.toBeNull();
    expect(container.querySelector('[data-provenance="absent"]')).toBeNull();
    expect(container.querySelector('[data-provenance="broken"]')).toBeNull();
  });

  it("still states its coverage rather than staying silent because it is good", () => {
    render(<TopicPageBody view={wellGroundedView()} />);
    expect(screen.getByTestId("coverage-map").textContent).toContain("27 of 30 pages mapped");
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* The two block-level states, forced                                         */
/* ────────────────────────────────────────────────────────────────────────── */

describe("TopicPageBody — a block that cannot show where it came from", () => {
  function viewWith(sources: { documentId: string; page: number }[]): TopicView {
    const good = wellGroundedView();
    return buildTopicView({
      topic: {
        id: TOPIC,
        course_id: COURSE,
        title: "T",
        slug: "t",
        summary: "",
        page: {
          summary: "",
          notes: [{ id: "orphan", heading: "An unsourced claim", markdown: "Trust me.", sources }],
          keyTerms: [],
          formulas: [],
          workedExamples: [],
          openQuestions: [],
        },
        exam_weight: 0.5,
        exam_weight_override: null,
        revision: 1,
        updated_at: "2026-07-20T10:00:00Z",
      },
      documents: [
        {
          id: GOOD_DOC,
          filename: "Sampling Distributions.pdf",
          session_label: "Lecture 7",
          kind: "slides",
          status: "ready",
          extraction_fidelity: "visual",
          failure_reason: null,
          coverage: good.documents[0]?.coverage ?? null,
          extraction: { extraction: { pages: pages(2, 30) } },
          failed_topics: [],
          created_at: "2026-07-20T09:00:00Z",
        },
      ],
      revisions: [],
    });
  }

  it("says so in prose when a block cites nothing at all", () => {
    const { container } = render(<TopicPageBody view={viewWith([])} />);
    expect(screen.getByText(/Nothing cites this/i)).toBeInTheDocument();
    expect(container.querySelector('[data-provenance="absent"]')).not.toBeNull();
    expect(screen.getByText(/1 block cites nothing at all/i)).toBeInTheDocument();
  });

  it("marks a chip broken when it points at a page the extractor never read", () => {
    const { container } = render(
      <TopicPageBody view={viewWith([{ documentId: GOOD_DOC, page: 400 }])} />,
    );
    expect(container.querySelector('[data-citation-status="unread-page"]')).not.toBeNull();
    expect(container.querySelector('[data-provenance="broken"]')).not.toBeNull();
    expect(
      screen.getByText(/1 citation points at a page or document this topic never read/i),
    ).toBeInTheDocument();
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Wave 5 gate — affordances Agent 2 shipped without a failing test           */
/*                                                                            */
/* Each of these was reachable for the first time only after the create-path  */
/* revision-0 fix landed (needs_review had no place to live before). A render  */
/* test is not enough; the assertion must go red if the affordance breaks.     */
/* ────────────────────────────────────────────────────────────────────────── */

function flaggableView(overrides: {
  readonly documentStatus?: string;
  readonly failedTopics?: readonly unknown[];
  readonly fidelity?: string | null;
  readonly latestNeedsReview?: boolean;
}): TopicView {
  const topic: TopicRow = {
    id: TOPIC,
    course_id: COURSE,
    title: "Sampling Distributions",
    slug: "sampling-distributions",
    summary: "How sample statistics behave.",
    page: {
      summary: "s",
      notes: [],
      keyTerms: [],
      formulas: [],
      workedExamples: [],
      openQuestions: [],
    },
    exam_weight: 0.5,
    exam_weight_override: null,
    revision: 2,
    updated_at: "2026-07-20T10:00:00Z",
  };

  const document: TopicDocumentRow = {
    id: GOOD_DOC,
    filename: "Sampling Distributions.pdf",
    session_label: "Lecture 7",
    kind: "slides",
    status: overrides.documentStatus ?? "ready",
    extraction_fidelity: overrides.fidelity === undefined ? "visual" : overrides.fidelity,
    failure_reason: null,
    coverage: {
      checked: true,
      pagesTotal: 30,
      pagesMapped: 27,
      pagesSkipped: 3,
      pagesUndeclared: 0,
      pagesUnmapped: 0,
      topicCount: 4,
      trustworthy: true,
      gaps: [],
      warnings: [],
      missingObjectives: [],
    },
    extraction: { extraction: { pages: pages(2, 30) } },
    failed_topics: overrides.failedTopics ?? [],
    created_at: "2026-07-20T09:00:00Z",
  };

  const revision: TopicRevisionRow = {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    revision: 1,
    page: { summary: "", notes: [], keyTerms: [], formulas: [], workedExamples: [] },
    change_summary: "Added the CLT block.",
    source: "merge",
    needs_review: overrides.latestNeedsReview ?? false,
    review_notes: [],
    document_id: GOOD_DOC,
    prompt_id: "topic-merge",
    prompt_version: 2,
    model: "claude-sonnet-5",
    created_at: "2026-07-20T10:00:00Z",
  };

  return buildTopicView({ topic, documents: [document], revisions: [revision] });
}

describe("NeedsReviewChip", () => {
  it("shows the chip when the newest revision is flagged", () => {
    render(<NeedsReviewChip view={flaggableView({ latestNeedsReview: true })} />);
    expect(screen.getByTestId("needs-review")).toBeInTheDocument();
    expect(screen.getByText(/Flagged for review/i)).toBeInTheDocument();
  });

  it("shows nothing when the newest revision is not flagged", () => {
    render(<NeedsReviewChip view={flaggableView({ latestNeedsReview: false })} />);
    expect(screen.queryByTestId("needs-review")).toBeNull();
  });
});

describe("PartialBanner", () => {
  it("warns, and counts the topics, when a feeding document only half-merged", () => {
    render(
      <TopicPageBody view={flaggableView({ documentStatus: "partial", failedTopics: [{}, {}] })} />,
    );
    expect(screen.getByText(/only half-merged/i)).toBeInTheDocument();
    expect(screen.getByText(/failed to merge into 2 topics/i)).toBeInTheDocument();
  });

  it("stays silent for a document that merged cleanly", () => {
    render(<TopicPageBody view={flaggableView({ documentStatus: "ready" })} />);
    expect(screen.queryByText(/only half-merged/i)).toBeNull();
  });
});

describe("FidelityNotes — text-only branch", () => {
  it("tells the reader that anything only inside a diagram is missing", () => {
    render(<TopicPageBody view={flaggableView({ fidelity: "text-only" })} />);
    const notes = screen.getByTestId("fidelity");
    expect(notes.textContent).toContain("read from its text only");
    expect(notes.textContent).toContain("not in these notes");
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Wave 7 — LaTeX is typeset, not shown as source                             */
/*                                                                            */
/* Both fixes are presentation-only. `wellGroundedView` already carries the    */
/* three math shapes these assert against: a formula block (display math), an  */
/* inline `$n > 30$` in a note, and inline math in a worked example. Every     */
/* assertion below is RED against the pre-KaTeX renderer — the formula source  */
/* sat in a `<pre>` and inline `$…$` stayed literal — so deleting the plugin    */
/* chain in `markdown.tsx` (or the `$$…$$` wrap in the formula block) turns     */
/* these red again. That is the property that makes them a guard.              */
/* ────────────────────────────────────────────────────────────────────────── */

describe("TopicPageBody — LaTeX renders as typeset math", () => {
  // The `\sigma_{\bar X} = \sigma / \sqrt n` carried by `wellGroundedView().page.formulas[0]`.
  const FORMULA_LATEX = "\\sigma_{\\bar{X}} = \\sigma / \\sqrt{n}";

  it("typesets the formula block and keeps the TeX source in the MathML annotation", () => {
    render(<TopicPageBody view={wellGroundedView()} />);
    const formulas = screen.getByTestId("formulas");

    const katex = formulas.querySelector(".katex");
    expect(katex).not.toBeNull();

    // The source survives, copy-selectable, in the MathML annotation — equal to the input.
    const annotation = formulas.querySelector('.katex annotation[encoding="application/x-tex"]');
    expect(annotation?.textContent?.trim()).toBe(FORMULA_LATEX);

    // …and no longer sits raw in a <pre>.
    expect(formulas.querySelector("pre")).toBeNull();
  });

  it("typesets inline math in prose and drops the literal dollar-delimited source", () => {
    const { container } = render(<TopicPageBody view={wellGroundedView()} />);
    const notes = screen.getByTestId("notes");

    expect(notes.querySelector(".katex")).not.toBeNull();
    // The delimiters are consumed by the renderer — the literal `$n > 30$` must be gone.
    expect(container.textContent).not.toContain("$n > 30$");
  });

  it("typesets under both reading themes with no per-theme colour pinned on KaTeX", () => {
    // `page.tsx` mounts the body under `.reading`, itself nested in `.dark` or the light
    // default. jsdom can't compute OKLCH, so assert STRUCTURE + inheritance, not pixels:
    // a `.katex` node exists in both registers, and its root pins no colour of its own, so
    // glyphs inherit the register's `--foreground`/currentColor rather than burning in one
    // theme's ink under the other.
    for (const wrapper of ["reading", "dark reading"]) {
      const { container, unmount } = render(
        <div className={wrapper}>
          <TopicPageBody view={wellGroundedView()} />
        </div>,
      );

      const katex = container.querySelector(".katex");
      expect(katex, `.katex under "${wrapper}"`).not.toBeNull();
      expect(katex?.getAttribute("style") ?? "").not.toContain("color");
      expect(
        container.querySelector('.katex annotation[encoding="application/x-tex"]'),
      ).not.toBeNull();

      unmount();
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Wave 7 — the reading column is anchored, not centred                       */
/*                                                                            */
/* `page.tsx` is an async RSC and cannot mount in jsdom, so the column's       */
/* className is an exported constant and asserted directly. RED while the      */
/* constant still carries `mx-auto`.                                          */
/* ────────────────────────────────────────────────────────────────────────── */

describe("READING_COLUMN_CLASS — anchored to the content-start gutter", () => {
  it("keeps the 68ch reading measure", () => {
    expect(READING_COLUMN_CLASS).toContain("max-w-[68ch]");
  });

  it("does not auto-centre the column in a wide viewport", () => {
    expect(READING_COLUMN_CLASS).not.toContain("mx-auto");
  });
});
