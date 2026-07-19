/**
 * Segmentation (PLAN §5 Step A.2): "split the extraction into candidate segments along its
 * structure (slide runs, headings)".
 *
 * A segment is the unit the routing call makes one decision about, so the quality of this
 * split sets a ceiling on routing quality. Two failure modes bound it from either side:
 * segments that are too big smear three concepts into one routing decision and force the
 * merger to integrate unrelated material into one topic; segments that are too small
 * produce a routing call per slide, which is both expensive and noisy — a single agenda
 * slide is not a topic.
 *
 * The split is **structural, never semantic**. It uses the headings the extractor already
 * found and the page ordering it already produced; it never asks a model where a topic
 * starts. That keeps it free, deterministic and unit-testable, and it means a re-run
 * segments identically — which is what makes the routing call's `input_hash` stable, and so
 * makes re-processing cheap rather than merely correct.
 *
 * ## The skipped-pages problem
 *
 * `documents.extraction.skipped[]` is the extractor's completeness ledger, and it is
 * **unaudited**: measured runs have declared 8 skipped pages of 19 and 6 of 22 without
 * anybody confirming those were reviewable choices rather than silent losses. Segmentation
 * is where that uncertainty first becomes actionable, so this module computes coverage
 * explicitly — {@link SegmentationResult.unaccountedPages} is the set of source units that
 * are in **neither** `pages` nor `skipped`, i.e. content the extractor lost without
 * declaring it.
 *
 * That number is not decoration. The loss-detector downgrades a phantom-locator finding to
 * `unverifiable` when it is non-zero, because a merger citing page 14 of a document whose
 * page 14 silently vanished from the extraction is not hallucinating — the evidence is
 * missing, which is a different thing and must not be reported as fabrication.
 */

/** The extractor's per-page output, structurally. Mirrors `extractedPageSchema`. */
export interface ExtractedPageLike {
  readonly page: number;
  readonly title?: string | null;
  readonly markdown: string;
}

/** The extractor's heading list, structurally. Mirrors `extractedHeadingSchema`. */
export interface ExtractedHeadingLike {
  readonly text: string;
  readonly level: number;
  readonly page: number;
}

/** A declared-skipped run, structurally. Mirrors `skippedRangeSchema`. */
export interface SkippedRangeLike {
  readonly fromPage: number;
  readonly toPage: number;
  readonly reason: string;
}

export interface SegmentationInput {
  readonly pages: readonly ExtractedPageLike[];
  readonly headings?: readonly ExtractedHeadingLike[];
  readonly skipped?: readonly SkippedRangeLike[];
  /** Pages/slides the source actually had, counted before the model saw it. */
  readonly sourceUnits?: number;
  /** Headings at or above this level start a new segment. Deeper ones are ignored. */
  readonly headingLevel?: number;
  /** Fallback run length when a document has no usable headings. */
  readonly maxPagesPerSegment?: number;
}

/** One routing decision's worth of the document. */
export interface Segment {
  /** Stable within a document, and stable across re-runs. The routing call's join key. */
  readonly key: string;
  /** Human label — the heading that opened the run, or "Pages 4–7". */
  readonly title: string;
  /** The concatenated markdown of every page in the run. */
  readonly markdown: string;
  readonly fromPage: number;
  readonly toPage: number;
  /** Every page number this segment covers, ascending. Becomes `topic_sources.locators`. */
  readonly pages: readonly number[];
}

export interface SegmentationResult {
  readonly segments: readonly Segment[];
  /** Every page the extraction actually returned content for. */
  readonly extractedPages: readonly number[];
  /** Every page the extractor declared it dropped, expanded from the ranges. */
  readonly declaredSkippedPages: readonly number[];
  /**
   * Source units in neither list — **undeclared loss**. Computable only when `sourceUnits`
   * is known; an empty array with an unknown `sourceUnits` means "not checked", which is
   * why {@link coverageChecked} exists rather than leaving the caller to infer it.
   */
  readonly unaccountedPages: readonly number[];
  readonly coverageChecked: boolean;
}

/** A heading at this level or above opens a new segment. */
const DEFAULT_HEADING_LEVEL = 2;
/** Slide runs, when there is no heading structure to follow. */
const DEFAULT_MAX_PAGES_PER_SEGMENT = 5;

function expandRange(from: number, to: number): number[] {
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  const out: number[] = [];
  for (let n = low; n <= high; n += 1) out.push(n);
  return out;
}

/**
 * Splits an extraction into routable segments.
 *
 * Boundaries come from headings when the document has them and from fixed page runs when it
 * does not — a deck of unlabelled slides is a real and common input, and a segmenter that
 * returned one giant segment for it would push the whole document into a single routing
 * decision.
 *
 * Both paths then apply the same run cap: a heading-delimited section longer than
 * `maxPagesPerSegment` is split further. Without that, a document with one heading on page
 * 1 and forty pages under it is exactly the "one giant segment" case again, arrived at
 * through the branch that was supposed to prevent it.
 */
export function segmentExtraction(input: SegmentationInput): SegmentationResult {
  const headingLevel = input.headingLevel ?? DEFAULT_HEADING_LEVEL;
  const maxPages = Math.max(1, input.maxPagesPerSegment ?? DEFAULT_MAX_PAGES_PER_SEGMENT);

  const pages = [...input.pages]
    .filter((page) => Number.isFinite(page.page))
    .sort((a, b) => a.page - b.page);

  const extractedPages = pages.map((page) => page.page);

  const declaredSkippedSet = new Set<number>();
  for (const range of input.skipped ?? []) {
    for (const n of expandRange(range.fromPage, range.toPage)) declaredSkippedSet.add(n);
  }

  const sourceUnits = input.sourceUnits;
  const coverageChecked = typeof sourceUnits === "number" && sourceUnits > 0;
  const unaccountedPages: number[] = [];
  if (coverageChecked) {
    const seen = new Set(extractedPages);
    for (let n = 1; n <= sourceUnits; n += 1) {
      if (!seen.has(n) && !declaredSkippedSet.has(n)) unaccountedPages.push(n);
    }
  }

  // ── Where does a new segment start? ────────────────────────────────────────
  const boundaryTitles = new Map<number, string>();
  for (const heading of input.headings ?? []) {
    if (heading.level > headingLevel) continue;
    // First heading on a page wins: a page carrying both an H1 and an H2 starts one
    // segment, named by the more significant of the two.
    const existing = boundaryTitles.get(heading.page);
    if (existing === undefined) boundaryTitles.set(heading.page, heading.text.trim());
  }

  const runs: ExtractedPageLike[][] = [];
  let current: ExtractedPageLike[] = [];
  const runTitles: (string | undefined)[] = [];

  for (const page of pages) {
    const isBoundary = boundaryTitles.has(page.page);
    if (current.length > 0 && (isBoundary || current.length >= maxPages)) {
      runs.push(current);
      current = [];
    }
    if (current.length === 0) runTitles[runs.length] = boundaryTitles.get(page.page);
    current.push(page);
  }
  if (current.length > 0) runs.push(current);

  const segments: Segment[] = runs.map((run, index) => {
    const first = run[0];
    const last = run[run.length - 1];
    // `run` is never empty — it is only pushed when `current.length > 0` — but
    // noUncheckedIndexedAccess cannot see that, and a non-null assertion would be a claim
    // rather than a check.
    const fromPage = first?.page ?? 0;
    const toPage = last?.page ?? fromPage;
    const heading = runTitles[index];
    const fallbackTitle = fromPage === toPage ? `Page ${fromPage}` : `Pages ${fromPage}–${toPage}`;

    return {
      key: `seg-${index + 1}`,
      title: heading !== undefined && heading !== "" ? heading : fallbackTitle,
      markdown: run
        .map((page) => {
          const pageTitle = (page.title ?? "").trim();
          const header = pageTitle === "" ? `[p.${page.page}]` : `[p.${page.page}] ${pageTitle}`;
          return `${header}\n${page.markdown}`;
        })
        .join("\n\n"),
      fromPage,
      toPage,
      pages: run.map((page) => page.page),
    };
  });

  return {
    segments,
    extractedPages,
    declaredSkippedPages: [...declaredSkippedSet].sort((a, b) => a - b),
    unaccountedPages,
    coverageChecked,
  };
}
