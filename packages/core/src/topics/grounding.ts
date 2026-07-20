/**
 * Merge-side grounding checks — **code, not LLM**, and independent of both.
 *
 * The loss-detector compares the page before a merge with the page after it, and the critic
 * asks another model whether the merge looks honest. Neither of them compares the produced
 * page against **the source text the merge was actually given**. That gap is exactly the
 * shape of the Wave 4 failure.
 *
 * The merger was handed one 577-character slide — a bullet list of learning objectives with
 * no display math anywhere in it — and returned a 12,296-character page carrying six full
 * LaTeX formulas, seven key terms and seven note blocks, every one of them citing that
 * slide. The formulas were *correct*: they are standard sampling-distribution results, and
 * five of the six really do appear in the deck, on pages the merge never saw. That is what
 * makes this failure mode so dangerous — correct-looking statistics is undetectable by the
 * student reading it, and a citation that leads to a slide containing none of it teaches
 * them the citation UI is noise. Worse than no citations at all.
 *
 * Two checks live here, both deterministic, both operating on the merge's own input:
 *
 * 1. {@link detectUngroundedContent} — content with no lexical anchor in the source.
 * 2. {@link measureExpansion} — output volume against input volume.
 *
 * ## Why these are lexical and shallow on purpose
 *
 * A semantic check needs a model, and a model is what the critic already is. The value of
 * this module is that it cannot be talked out of its answer: "the input contains no display
 * math and the output contains six formulas" is arithmetic. It will miss paraphrase and it
 * will miss a fabricated claim that reuses the source's vocabulary. It is a floor, not a
 * ceiling, and it is deliberately biased toward silence — every rule below fires only on
 * evidence of *absence*, which is the direction that does not produce false alarms on the
 * ordinary case of a merge doing its job well.
 */

import type { TopicPageLike } from "./page";

export type GroundingFindingKind =
  /** Formulas on the page when the source given to the merge had no mathematics at all. */
  | "formulas-without-source-math"
  /** A key term whose name appears nowhere in the source text. */
  | "unanchored-key-term";

export interface GroundingFinding {
  readonly kind: GroundingFindingKind;
  readonly subject: string;
  /** One sentence, safe to put in front of a person. */
  readonly detail: string;
}

/** Display math in any of the notations the extractor and the merger both use. */
const DISPLAY_MATH = /\$\$|\\\[|\\begin\{(?:equation|align|gather|multline)/;
/** Any mathematics at all, including a bare inline `$x$`. */
const ANY_MATH = /\$[^$\n]+\$|\$\$|\\\[|\\begin\{/;

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

/**
 * Content on the produced page that the merge's own source material does not anchor.
 *
 * `sourceText` is the concatenated markdown of every segment routed to this topic — the
 * literal text the merge prompt carried, not the whole document. That scoping is the point:
 * a page may legitimately contain material from *earlier* documents, so only blocks that
 * cite **this** merge's contribution are judged, and the question asked of them is whether
 * the text they claim to come from could plausibly have produced them.
 */
export function detectUngroundedContent(input: {
  readonly page: TopicPageLike;
  /** Every routed segment's markdown, concatenated. */
  readonly sourceText: string;
  /** True for a first merge. Only then is the page wholly attributable to this source. */
  readonly isNewTopic: boolean;
}): readonly GroundingFinding[] {
  // On an update, the page carries other documents' material and this module cannot tell
  // which block came from where. Reporting inherited content as ungrounded would be a false
  // accusation, so the check declines to run rather than guessing.
  if (!input.isNewTopic) return [];

  const source = normalise(input.sourceText);
  const findings: GroundingFinding[] = [];

  const formulas = input.page.formulas ?? [];
  if (formulas.length > 0 && !DISPLAY_MATH.test(input.sourceText)) {
    // The Wave 4 case exactly. Note the asymmetry: bare inline `$\hat{p}$` in a prose bullet
    // does NOT count as a source for a displayed formula, which is why the two patterns are
    // separate and this one is the strict one.
    findings.push({
      kind: "formulas-without-source-math",
      subject: `${formulas.length} formula${formulas.length === 1 ? "" : "s"}`,
      detail: `This page states ${formulas.length} formula${formulas.length === 1 ? "" : "s"}, but the source material it was built from contains no displayed mathematics${ANY_MATH.test(input.sourceText) ? " — only symbols mentioned inline in prose" : " at all"}. ${formulas.length === 1 ? "It was" : "They were"} not taken from what this file provided.`,
    });
  }

  for (const term of input.page.keyTerms ?? []) {
    const name = (term.term ?? "").trim();
    if (name.length < 3) continue;
    if (source.includes(normalise(name))) continue;
    findings.push({
      kind: "unanchored-key-term",
      subject: name,
      detail: `The key term “${name}” does not appear anywhere in the source material this page was built from.`,
    });
  }

  // Worked examples are deliberately NOT checked. They carry `problem` and `solution` prose
  // that the merger legitimately rewrites, so no lexical anchor survives the rewrite and any
  // rule over them is a false-positive generator. The honest signal about worked examples on
  // the Wave 4 run was the opposite one — the page had NONE while the extraction carried four
  // — and absence is what `uncited-routed-pages` and the expansion ratio measure.

  return findings;
}

/**
 * Above this output-to-input character ratio, a first merge is inventing rather than
 * summarising.
 *
 * Wave 4 turned 577 characters of input into 12,296 characters of page — 21×. A merge that
 * genuinely writes study prose from slide bullets does expand its input, so this is set well
 * above the honest case: measured merges of real slide runs sit near 1–3×, because slide
 * markdown is verbose and the page is denser than it looks. 8× leaves a wide margin and
 * still catches an order-of-magnitude fabrication.
 */
export const MAX_EXPANSION_RATIO = 8;

export interface ExpansionMeasurement {
  readonly sourceChars: number;
  readonly pageChars: number;
  readonly ratio: number;
  /** True when the page is implausibly large for the material it was built from. */
  readonly implausible: boolean;
  /** One sentence when `implausible`, else null. */
  readonly detail: string | null;
}

/**
 * How much bigger the produced page is than the material it was built from.
 *
 * This is the check that does not depend on knowing *how* the pipeline broke. Routing loss,
 * a truncated prompt, a segment that failed to render — all of them arrive here as the same
 * observable, a page far larger than its input, and all of them are caught without this
 * module needing a theory about which one happened.
 */
export function measureExpansion(input: {
  readonly sourceText: string;
  readonly page: TopicPageLike;
  readonly isNewTopic: boolean;
}): ExpansionMeasurement {
  const sourceChars = input.sourceText.length;
  const pageChars = JSON.stringify(input.page).length;
  const ratio = sourceChars === 0 ? Number.POSITIVE_INFINITY : pageChars / sourceChars;

  // The RATIO alone, deliberately. An absolute floor on input size was tried and removed:
  // a topic legitimately fed one short slide is an ordinary case, and flagging it teaches
  // the reader to ignore the flag. The ratio catches the Wave 4 run at 21× without needing
  // an opinion about how short a slide is allowed to be.
  //
  // Only meaningful on a create. An update's page is mostly prior material, so its ratio
  // against one document's contribution says nothing.
  const implausible = input.isNewTopic && ratio > MAX_EXPANSION_RATIO;

  return {
    sourceChars,
    pageChars,
    ratio,
    implausible,
    detail: implausible
      ? `This page is ${Math.round(ratio)}× the size of the material it was built from (${pageChars} characters written from ${sourceChars}). A first page that large from a source that small is not summarising it.`
      : null,
  };
}
