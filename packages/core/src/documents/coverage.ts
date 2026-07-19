/**
 * The coverage map (PLAN "Document & Notes Pipeline" §5 *Completeness & coverage*, §8).
 *
 * > Silent omission — a topic from a 600-page book that never became a page — is caught by
 * > **measuring** coverage, not by trusting the model to confess.
 *
 * That sentence is the specification and it has a sharp edge: **the thing being measured is
 * partly reported by the thing being measured.** `documents.extraction.skipped[]` is the
 * extractor's own account of what it dropped, and a coverage map that simply believes it
 * computes "100% covered" for a document the model quietly abridged — which is not a
 * cosmetic error, it is the exact failure the feature exists to catch, arriving through the
 * feature's own input.
 *
 * ## `skipped[]` IS UNAUDITED, and this module is written as if it were hostile
 *
 * Measured on the live corpus: extractions declared **8 skipped pages of 19** and **6 of
 * 22**, and nobody has read the reasons to confirm those were reviewable choices rather than
 * silent losses. So every claim `skipped[]` makes is treated as a claim:
 *
 * - a range with no reason, or a boilerplate one, is **not a declaration** — it is demoted
 *   to `undeclared` and counted as loss;
 * - a range outside the document is discarded and flagged, never allowed to inflate the
 *   skipped count;
 * - overlapping and duplicate ranges are deduplicated by page, so declaring "1–19" three
 *   times does not become 57 accounted pages;
 * - a document that declares more than {@link SUSPICIOUS_SKIP_RATIO} of itself skipped is
 *   marked **untrustworthy** regardless of how good the reasons look.
 *
 * And the load-bearing one: **a declared-skipped page is never counted as mapped.** Skipping
 * is a gap with an explanation, not coverage. `pagesMapped` counts only pages that actually
 * reached a topic page, so the headline number cannot be inflated by the model declining to
 * read something.
 *
 * ## Why `checked` exists
 *
 * `sourceUnits` — the page count taken from the file *before* the model saw it — is the only
 * independent measurement in the whole calculation. Without it there is no denominator, and
 * "100% of the pages we know about" is a tautology. When it is absent this map reports
 * `checked: false` and {@link coverageSummary} refuses to state a percentage. A coverage
 * feature that reports reassuring numbers when it has nothing to compare against is worse
 * than no coverage feature, because it is trusted.
 *
 * Pure: no I/O, no clock, no `process.env`. `documents.coverage` stores the result verbatim.
 */

/** A declared-skipped run, structurally. Mirrors `skippedRangeSchema`. */
export interface CoverageSkippedRange {
  readonly fromPage: number;
  readonly toPage: number;
  readonly reason: string;
}

/**
 * Above this share of declared-skipped pages, the extraction is untrustworthy on its face.
 *
 * A third of a document is a lot of front matter. The measured corpus sits right at this
 * line (8 of 19 ≈ 42%, 6 of 22 ≈ 27%), which is precisely why the threshold is here rather
 * than somewhere comfortable — it is set to flag the runs we have actually seen, not to
 * quietly pass them.
 */
export const SUSPICIOUS_SKIP_RATIO = 0.3;

/** A reason too generic to be a reviewable choice. Matched case-insensitively, whole-string. */
const EMPTY_REASONS = new Set([
  "",
  "-",
  "n/a",
  "na",
  "none",
  "null",
  "skipped",
  "skip",
  "other",
  "unknown",
  "not applicable",
  "no reason",
]);

/**
 * Whether a `skipped[]` reason is a genuine declaration.
 *
 * §4.1 asks for "'title slide', 'agenda', 'bibliography', 'duplicate of page 12'" — concrete
 * enough that "a human reads this to decide whether to disagree". A reason a human cannot
 * disagree with is not a declaration; it is the shape of one. Demoting it to undeclared loss
 * is the whole defensive posture of this module in one function.
 */
export function isGenuineSkipReason(reason: string): boolean {
  const normalized = reason.trim().toLowerCase();
  if (EMPTY_REASONS.has(normalized)) return false;
  // Two characters cannot describe why a page was dropped.
  return normalized.length >= 3;
}

export type CoverageGapKind =
  /** The extractor declared it dropped these pages, with a reason a human can review. */
  | "skipped"
  /** Extracted, but no topic page ended up citing it. Content read and then not used. */
  | "unmapped"
  /** In neither `pages` nor a credible `skipped[]` entry. **Silent loss.** */
  | "undeclared";

export interface CoverageGap {
  readonly fromPage: number;
  readonly toPage: number;
  readonly kind: CoverageGapKind;
  /** Shown in the UI next to the clickable range. Never empty. */
  readonly reason: string;
}

export interface CoverageMap {
  /**
   * Whether an independent page count was available. **When false, no percentage this
   * object contains means anything**, and `coverageSummary` will not state one.
   */
  readonly checked: boolean;
  /** The denominator: pages the file actually had, counted before the model read it. */
  readonly pagesTotal: number;
  /** Pages that reached at least one topic page. The only number that counts as coverage. */
  readonly pagesMapped: number;
  /** Pages credibly declared skipped. Gaps with an explanation — not coverage. */
  readonly pagesSkipped: number;
  /** Pages in neither `pages` nor a credible `skipped[]`. Silent loss. */
  readonly pagesUndeclared: number;
  /** Extracted but never cited by a topic. Read, then dropped on the floor. */
  readonly pagesUnmapped: number;
  /** Every gap as a contiguous clickable range, ascending (§8). */
  readonly gaps: readonly CoverageGap[];
  readonly topicCount: number;
  /**
   * Whether the numbers above may be presented as fact.
   *
   * False when there was no denominator, when a credible share of the document went
   * undeclared, or when the extractor declared an implausible amount skipped. The UI shows
   * the same figures either way — it adds a caveat, rather than hiding the measurement,
   * because a suppressed number is indistinguishable from a good one.
   */
  readonly trustworthy: boolean;
  /** Why `trustworthy` is false, and any range that had to be discarded. Empty when clean. */
  readonly warnings: readonly string[];
  /**
   * Syllabus objectives with no covering topic (§5's importance oracle).
   *
   * Lives on the coverage map rather than on a topic page because a *fully* uncovered
   * objective has no topic page to live on — see the ⚠ CORRECTED note in PLAN §5.
   */
  readonly missingObjectives: readonly string[];
}

export interface CoverageInput {
  /** Pages the file had, counted before the model saw it. 0 or absent means "unknown". */
  readonly sourceUnits?: number;
  /** Pages the extraction returned content for. */
  readonly extractedPages: readonly number[];
  /** The extractor's completeness ledger. Treated as a claim — see the module note. */
  readonly skipped?: readonly CoverageSkippedRange[];
  /** Pages that actually reached a topic page, via `topic_sources.locators`. */
  readonly mappedPages: readonly number[];
  readonly topicCount: number;
  readonly missingObjectives?: readonly string[];
}

function isPageNumber(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

/** Contiguous runs of a sorted, deduplicated page list, as `[from, to]` pairs. */
function toRanges(pages: readonly number[]): { from: number; to: number }[] {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const ranges: { from: number; to: number }[] = [];
  for (const page of sorted) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && page === last.to + 1) {
      last.to = page;
    } else {
      ranges.push({ from: page, to: page });
    }
  }
  return ranges;
}

/**
 * Computes the coverage map.
 *
 * The arithmetic is deliberately simple and the judgement is all in what counts as what:
 * `mapped` is the only category that means "this content is in your notes", and every other
 * page is a gap of some kind with a reason attached to it.
 */
export function computeCoverage(input: CoverageInput): CoverageMap {
  const warnings: string[] = [];

  const extracted = new Set(input.extractedPages.filter(isPageNumber));
  const mappedAll = new Set(input.mappedPages.filter(isPageNumber));

  const declaredUnits = input.sourceUnits;
  const checked =
    typeof declaredUnits === "number" && Number.isInteger(declaredUnits) && declaredUnits > 0;

  // Without an independent count there is no honest denominator. The highest page anyone
  // mentioned is used so the object is still renderable, and `checked` says not to trust it.
  const pagesTotal = checked ? declaredUnits : Math.max(0, ...extracted, ...mappedAll);

  // ── The skipped ledger, audited ───────────────────────────────────────────
  const credibleSkipped = new Set<number>();
  const skippedReasons = new Map<number, string>();
  const discreditedSkipped = new Set<number>();

  for (const range of input.skipped ?? []) {
    const from = Math.min(range.fromPage, range.toPage);
    const to = Math.max(range.fromPage, range.toPage);

    if (!isPageNumber(from) || !isPageNumber(to)) {
      warnings.push(
        `A skipped range (${range.fromPage}–${range.toPage}) was not a page range and was ignored.`,
      );
      continue;
    }
    if (pagesTotal > 0 && from > pagesTotal) {
      // A range past the end of the document cannot be describing this document.
      warnings.push(
        `A skipped range (${from}–${to}) lies outside this ${pagesTotal}-page document and was ignored.`,
      );
      continue;
    }

    const genuine = isGenuineSkipReason(range.reason);
    if (!genuine) {
      warnings.push(
        `Pages ${from}–${to} were reported skipped with no usable reason (“${range.reason.trim()}”), so they are counted as undeclared rather than as a reviewed omission.`,
      );
    }

    for (let page = from; page <= Math.min(to, pagesTotal > 0 ? pagesTotal : to); page += 1) {
      // A page the extractor BOTH returned content for and declared skipped is a
      // contradiction in its own ledger. Content wins — we have the text — but it must not
      // also be counted as a reviewed omission.
      if (extracted.has(page)) continue;
      if (genuine) {
        credibleSkipped.add(page);
        if (!skippedReasons.has(page)) skippedReasons.set(page, range.reason.trim());
      } else {
        discreditedSkipped.add(page);
      }
    }
  }

  for (const page of credibleSkipped) discreditedSkipped.delete(page);

  // ── The four categories ───────────────────────────────────────────────────
  //
  // `mapped` is intersected with the document's own page range: a topic citing page 400 of
  // a 27-page deck is a phantom citation, and letting it count as coverage would let a
  // hallucinated locator raise the coverage number.
  const mapped = new Set([...mappedAll].filter((page) => pagesTotal === 0 || page <= pagesTotal));
  const phantomCitations = [...mappedAll].filter((page) => pagesTotal > 0 && page > pagesTotal);
  if (phantomCitations.length > 0) {
    warnings.push(
      `${phantomCitations.length} citation${phantomCitations.length === 1 ? "" : "s"} point past the end of this ${pagesTotal}-page document (${phantomCitations.slice(0, 5).join(", ")}) and were not counted as covered.`,
    );
  }

  const unmapped: number[] = [];
  const undeclared: number[] = [];

  if (pagesTotal > 0) {
    for (let page = 1; page <= pagesTotal; page += 1) {
      if (mapped.has(page)) continue;
      if (credibleSkipped.has(page)) continue;
      if (extracted.has(page)) {
        unmapped.push(page);
      } else {
        undeclared.push(page);
      }
    }
  }

  // ── Gaps, as clickable ranges ─────────────────────────────────────────────
  const gaps: CoverageGap[] = [
    ...toRanges([...credibleSkipped]).map((range) => ({
      fromPage: range.from,
      toPage: range.to,
      kind: "skipped" as const,
      reason: skippedReasons.get(range.from) ?? "declared skipped",
    })),
    ...toRanges(unmapped).map((range) => ({
      fromPage: range.from,
      toPage: range.to,
      kind: "unmapped" as const,
      reason: "read, but no topic page cites it",
    })),
    ...toRanges(undeclared).map((range) => ({
      fromPage: range.from,
      toPage: range.to,
      kind: "undeclared" as const,
      reason: discreditedSkipped.has(range.from)
        ? "reported skipped without a usable reason"
        : "not read and not declared skipped",
    })),
  ].sort((a, b) => a.fromPage - b.fromPage || a.toPage - b.toPage);

  // ── Trust ─────────────────────────────────────────────────────────────────
  if (!checked) {
    warnings.push(
      "This document's page count could not be established independently, so coverage could not be verified — the figures below describe only what the reader reported.",
    );
  }
  if (undeclared.length > 0) {
    warnings.push(
      `${undeclared.length} page${undeclared.length === 1 ? " was" : "s were"} neither read nor declared skipped. Content on ${undeclared.length === 1 ? "it" : "them"} is missing from your notes without anything saying so.`,
    );
  }
  if (pagesTotal > 0 && credibleSkipped.size / pagesTotal > SUSPICIOUS_SKIP_RATIO) {
    warnings.push(
      `${credibleSkipped.size} of ${pagesTotal} pages were declared skipped — a large share for one document. The reasons are worth reading before trusting these notes as complete.`,
    );
  }

  const trustworthy =
    checked &&
    undeclared.length === 0 &&
    (pagesTotal === 0 || credibleSkipped.size / pagesTotal <= SUSPICIOUS_SKIP_RATIO);

  return {
    checked,
    pagesTotal,
    pagesMapped: mapped.size,
    pagesSkipped: credibleSkipped.size,
    pagesUndeclared: undeclared.length,
    pagesUnmapped: unmapped.length,
    gaps,
    topicCount: input.topicCount,
    trustworthy,
    warnings,
    missingObjectives: input.missingObjectives ?? [],
  };
}

/**
 * §8's one-line coverage sentence.
 *
 * > "587 of 600 pages mapped across 24 topics · 13 unmapped (front matter, index)"
 *
 * Refuses to state a ratio when `checked` is false. That refusal is the point: the sentence
 * is the whole product surface for this feature, and a sentence that reads identically
 * whether or not the measurement was possible makes the measurement worthless.
 */
export function coverageSummary(map: CoverageMap): string {
  const topics = `${map.topicCount} topic${map.topicCount === 1 ? "" : "s"}`;

  if (!map.checked) {
    return `${map.pagesMapped} page${map.pagesMapped === 1 ? "" : "s"} mapped across ${topics} · this document's length couldn't be verified, so coverage is unknown`;
  }

  const head = `${map.pagesMapped} of ${map.pagesTotal} pages mapped across ${topics}`;
  const gapCount = map.pagesTotal - map.pagesMapped;
  if (gapCount <= 0) return head;

  // The reasons, deduplicated and in gap order — this is the parenthetical §8 shows.
  const reasons = Array.from(new Set(map.gaps.map((gap) => gap.reason))).slice(0, 3);
  const detail = reasons.length === 0 ? "" : ` (${reasons.join(", ")})`;

  const undeclaredNote =
    map.pagesUndeclared === 0 ? "" : ` · ${map.pagesUndeclared} unaccounted for`;

  return `${head} · ${gapCount} unmapped${detail}${undeclaredNote}`;
}
