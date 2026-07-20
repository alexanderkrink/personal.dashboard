/**
 * Reading a produced topic page's provenance, so a person can judge whether to trust it.
 *
 * ## Why this is a module and not a `.map()` in a component
 *
 * Wave 4 shipped a topic page whose twenty citations all pointed at the same slide — the
 * learning-objectives list, which contains none of the material the page states. The page
 * was `status: ready`, `trustworthy: true`, `warnings: []`, and every processing event was
 * `level: info`. Nothing in the product said otherwise, and nothing could have: the
 * question "do this page's citations span the material it was built from?" had no code
 * that asked it.
 *
 * This module asks it. It is pure, it operates on the stored artifact plus the documents
 * that fed it, and it is the input to the rendering decision — **not** the rendering
 * decision itself. That split is deliberate. The affordance the product needs is that a
 * badly-sourced block LOOKS badly sourced, and an affordance whose logic lives inside JSX
 * cannot be tested against the real failing artifact. Here it can, and it is: see
 * `provenance.test.ts`, which asserts every judgement below against the frozen Wave 4
 * corpus and against a well-grounded page, and fails if either verdict flips.
 *
 * ## The bias is toward stating the number, never toward reassurance
 *
 * Every function here reports what it measured even when the measurement is unremarkable.
 * A suppressed signal is indistinguishable from a good one, which is precisely how 1-of-54
 * pages mapped rendered as a clean page. So `ProvenanceReport` always carries its counts,
 * and the states that matter — {@link CitationCollapse}, `absent`, `broken` — are separate
 * named things rather than a single "quality score" that averages a catastrophe into a B+.
 */

import { type BlockKind, type BlockSourceLike, flattenTopicPage, type TopicPageLike } from "./page";

/* ────────────────────────────────────────────────────────────────────────── */
/* Inputs                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * A document that fed this topic, as far as provenance is concerned.
 *
 * `pagesRead` is the pages the **extraction** actually produced text for — not the page
 * count of the file. That distinction is what lets a citation be judged: a block citing
 * page 40 of a document whose extractor only ever read pages 1–12 is pointing at text that
 * no part of this pipeline has ever seen, and saying so is more useful than rendering the
 * number in a chip as though it were a fact.
 *
 * An empty `pagesRead` means "unknown", not "nothing" — an older document row may have no
 * retained extraction. Citations against such a document are resolved rather than
 * pessimistically broken, because inventing a defect is as dishonest as hiding one.
 */
export interface ProvenanceDocumentLike {
  readonly id: string;
  /** Human label — `session_label` when set, else the filename. */
  readonly label: string;
  /** 1-based pages the extraction produced text for. Empty means unknown. */
  readonly pagesRead: readonly number[];
}

export interface ProvenanceInput {
  readonly page: TopicPageLike;
  readonly documents: readonly ProvenanceDocumentLike[];
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Citations                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Whether a single citation points anywhere real.
 *
 * - `resolved` — names a known document, and a page that document was read on.
 * - `unread-page` — names a known document, but a page its extraction never produced. The
 *   chip cannot take you anywhere, and the content it vouches for has no witness.
 * - `unknown-document` — names no document, or one that is not among this topic's sources.
 */
export type CitationStatus = "resolved" | "unread-page" | "unknown-document";

export interface ProvenanceCitation {
  readonly documentId: string | null;
  readonly page: number | null;
  /** Mono chip text — "Lecture 7 · p. 12". Always says something true. */
  readonly label: string;
  readonly status: CitationStatus;
}

/** The page a source names, reading the flat and the legacy nested shape alike. */
function sourcePage(source: BlockSourceLike): number | null {
  const flat = source.page;
  if (typeof flat === "number" && Number.isFinite(flat)) return flat;
  const nested = source.locator;
  if (nested === null || nested === undefined) return null;
  const page = nested.page;
  if (typeof page === "number" && Number.isFinite(page)) return page;
  const slide = nested.slide;
  if (typeof slide === "number" && Number.isFinite(slide)) return slide;
  return null;
}

/** A citation's identity for "how many distinct places does this page cite?". */
function locatorKey(citation: ProvenanceCitation): string {
  return `${citation.documentId ?? "?"}#${citation.page ?? "?"}`;
}

function resolveCitation(
  source: BlockSourceLike,
  documents: ReadonlyMap<string, ProvenanceDocumentLike>,
): ProvenanceCitation {
  const documentId = (source.documentId ?? "").trim() === "" ? null : (source.documentId ?? null);
  const page = sourcePage(source);
  const document = documentId === null ? undefined : documents.get(documentId);

  if (document === undefined) {
    return {
      documentId,
      page,
      label: page === null ? "Source unknown" : `Unknown source · p. ${page}`,
      status: "unknown-document",
    };
  }

  // Empty `pagesRead` is "we do not know what was read", so it cannot falsify a page.
  const readable = document.pagesRead.length === 0 || page === null;
  const wasRead = readable || document.pagesRead.includes(page as number);

  return {
    documentId,
    page,
    label: page === null ? document.label : `${document.label} · p. ${page}`,
    status: wasRead ? "resolved" : "unread-page",
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Blocks                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * How well one block is sourced. The rendering contract is that these are **four visually
 * different things**, not four shades of the same badge.
 *
 * - `absent` — no citations at all. Nothing vouches for this content.
 * - `broken` — it has citations and not one of them resolves.
 * - `single` — exactly one place in one document. Legitimate and common; it is only weak in
 *   context, which is why the weakness verdict is computed at page level (see
 *   {@link CitationCollapse}) rather than being baked into this word.
 * - `corroborated` — two or more distinct places.
 */
export type ProvenanceStrength = "absent" | "broken" | "single" | "corroborated";

export interface ProvenanceBlock {
  readonly key: string;
  readonly kind: BlockKind;
  readonly label: string;
  readonly citations: readonly ProvenanceCitation[];
  readonly strength: ProvenanceStrength;
}

function strengthOf(citations: readonly ProvenanceCitation[]): ProvenanceStrength {
  if (citations.length === 0) return "absent";
  const resolved = citations.filter((c) => c.status === "resolved");
  if (resolved.length === 0) return "broken";
  const distinct = new Set(resolved.map(locatorKey));
  return distinct.size >= 2 ? "corroborated" : "single";
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The page-level signature                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Below this many citations, "they all point at one page" is an ordinary short page rather
 * than a signature. A two-block page sourced from one slide is fine and says nothing.
 */
export const COLLAPSE_MIN_CITATIONS = 3;

/**
 * Below this many pages available to cite, one distinct citation is not evidence of
 * anything — a topic built from a three-page handout that cites page 2 throughout has not
 * collapsed, it is just small.
 */
export const COLLAPSE_MIN_PAGES_AVAILABLE = 4;

/**
 * Every citation on the page pointing at the same single location.
 *
 * This is the Wave 4 signature stated exactly: 20 citations, one distinct locator, 48 pages
 * read. It is a **page-level** finding on purpose. Per block, "cites p. 2" looks like
 * ordinary provenance and the twentieth one looks no different from the first; the defect
 * only exists in the aggregate, so the aggregate is where it has to be said.
 */
export interface CitationCollapse {
  /** The one place everything claims to come from. */
  readonly locator: string;
  readonly citationCount: number;
  /** Distinct pages the citing documents were actually read on. */
  readonly pagesAvailable: number;
  /** One sentence, safe to put in front of a person. */
  readonly detail: string;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The report                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

export interface ProvenanceReport {
  readonly blocks: readonly ProvenanceBlock[];
  /** Every citation on the page, across all block families. */
  readonly citationCount: number;
  /** How many distinct (document, page) pairs those citations name. */
  readonly distinctLocatorCount: number;
  /** Distinct pages the feeding documents were read on — the denominator worth knowing. */
  readonly pagesAvailable: number;
  readonly blocksWithoutSources: number;
  readonly brokenCitationCount: number;
  /** Non-null only for the total-collapse case. See {@link CitationCollapse}. */
  readonly collapse: CitationCollapse | null;
  /** True when anything on this page should be rendered as less than sound. */
  readonly hasWeakness: boolean;
}

/**
 * Reads a topic page's provenance against the documents that fed it.
 *
 * Note what this does NOT do: it never opens the source text and never judges whether a
 * cited page supports the claim made on it. That is a semantic question and it needs a
 * model. What is here is arithmetic over locators, and arithmetic cannot be talked out of
 * its answer — which is the property that was missing when a page with one distinct
 * citation across twenty blocks shipped as trustworthy.
 */
export function analyseProvenance(input: ProvenanceInput): ProvenanceReport {
  const documents = new Map(input.documents.map((d) => [d.id, d]));

  const blocks: ProvenanceBlock[] = flattenTopicPage(input.page).map((block) => {
    const citations = block.sources.map((source) => resolveCitation(source, documents));
    return {
      key: block.key,
      kind: block.kind,
      label: block.label,
      citations,
      strength: strengthOf(citations),
    };
  });

  const allCitations = blocks.flatMap((b) => b.citations);
  const resolved = allCitations.filter((c) => c.status === "resolved");
  const distinctLocators = new Set(resolved.map(locatorKey));

  // Only the documents this page actually cites contribute a denominator. Counting pages
  // from a document the page never mentions would inflate the gap with material this topic
  // was never offered.
  const citedDocumentIds = new Set(
    allCitations.map((c) => c.documentId).filter((id): id is string => id !== null),
  );
  const pagesAvailable = new Set(
    [...citedDocumentIds].flatMap((id) =>
      (documents.get(id)?.pagesRead ?? []).map((p) => `${id}#${p}`),
    ),
  ).size;

  const blocksWithoutSources = blocks.filter((b) => b.strength === "absent").length;
  const brokenCitationCount = allCitations.filter((c) => c.status !== "resolved").length;

  const collapse = detectCollapse({
    citations: resolved,
    distinctLocators,
    pagesAvailable,
    documents,
  });

  return {
    blocks,
    citationCount: allCitations.length,
    distinctLocatorCount: distinctLocators.size,
    pagesAvailable,
    blocksWithoutSources,
    brokenCitationCount,
    collapse,
    hasWeakness:
      collapse !== null ||
      blocksWithoutSources > 0 ||
      brokenCitationCount > 0 ||
      // A page whose blocks are all unsourced has no citations at all — caught above — but a
      // page with content and zero citations of any kind is its own kind of nothing.
      (blocks.length > 0 && allCitations.length === 0),
  };
}

function detectCollapse(args: {
  readonly citations: readonly ProvenanceCitation[];
  readonly distinctLocators: ReadonlySet<string>;
  readonly pagesAvailable: number;
  readonly documents: ReadonlyMap<string, ProvenanceDocumentLike>;
}): CitationCollapse | null {
  const { citations, distinctLocators, pagesAvailable } = args;

  if (citations.length < COLLAPSE_MIN_CITATIONS) return null;
  if (distinctLocators.size !== 1) return null;
  if (pagesAvailable < COLLAPSE_MIN_PAGES_AVAILABLE) return null;

  const first = citations[0];
  if (first === undefined) return null;

  return {
    locator: first.label,
    citationCount: citations.length,
    pagesAvailable,
    detail:
      `All ${citations.length} citations on this page point at the same place — ${first.label} — ` +
      `out of ${pagesAvailable} pages that were read. Everything here claims to come from one page, ` +
      `so nothing on this page has been checked against the rest of the material.`,
  };
}
