/**
 * The deterministic block-diff loss-detector (PLAN §5 Step B2.1) — **code, not LLM**.
 *
 * Half of the "verify before persisting" gate, and the half that is exact, free and always
 * runs. The critic (§5 Step B2.2) is a model and can be wrong in both directions; this is
 * arithmetic on two JSON documents and cannot be.
 *
 * It answers exactly two questions, and deliberately not a third:
 *
 * 1. **Did a block disappear without being declared superseded?** A merge is allowed to
 *    remove content — PLAN §5 Step B says so — but only when it says it did. So the merge
 *    schema carries an explicit `removals[{blockKey, reason}]` list, and a block present
 *    before and absent after that is *not* in that list is a red flag.
 * 2. **Does a citation point at something this document does not contain?** New and edited
 *    blocks must cite this document's locators; a citation of page 14 when no routed
 *    segment covers page 14 is either a fabricated source or a mis-routed one.
 *
 * It does **not** judge whether the new text is good, faithful, or well-structured. That is
 * the critic's job, on a different model family, precisely because it is a judgement call.
 * Mixing the two here would make the exact check inherit the fuzzy one's false positives.
 *
 * ## Why `removals` is a schema field and not a string search
 *
 * The obvious implementation of "the changeSummary must say so" is to search the summary
 * text for the block's heading. That is a heuristic wearing a determinism costume: it fails
 * on paraphrase ("consolidated the pricing sections"), fires spuriously on any summary that
 * happens to mention a block it kept, and gives the merger an incentive to name-drop every
 * block it touched. Requiring a structured list makes the claim machine-checkable, makes
 * "which block, and why" legible to a human reading the revision history, and costs the
 * model one array it was already reasoning about.
 *
 * ## Defensive against an unaudited extraction
 *
 * `skipped[]` is unaudited and extractions have silently dropped pages. So a citation the
 * routed segments cannot vouch for is only called `phantom-locator` when the document's
 * coverage was actually checked and came back complete. When pages went missing
 * undeclared, the same citation is reported as `unverifiable-locator` at `amber` — the
 * evidence is gone, which is not the same as the evidence never existing, and reporting a
 * lossy extraction as model hallucination would send every investigation the wrong way.
 */

import {
  type BlockSourceLike,
  type DiffBlock,
  flattenTopicPage,
  locatorUnit,
  type TopicPageLike,
} from "./page";

/**
 * Below this share of routed pages cited, the produced page is not representing its input.
 *
 * Wave 4 sat at 1/48 ≈ 2%. The floor is at half because the case worth catching is the
 * partial one — a topic fed ten slides that cites three — and anything stricter would fire
 * on the ordinary merge that consolidates several slides into one well-cited block and
 * spend a Sonnet re-merge doing it.
 */
const CITED_ROUTED_SHARE_FLOOR = 0.5;

/**
 * Below this many routed pages the ratio is noise, so the check does not run.
 *
 * A topic fed one or two slides can legitimately cite one of them; the denominator is too
 * small for a share to mean anything.
 */
const MIN_ROUTED_FOR_CITATION_CHECK = 3;

/** A removal the merge explicitly declared. `blockKey` matches {@link DiffBlock.key}. */
export interface DeclaredRemoval {
  readonly blockKey: string;
  readonly reason: string;
}

export type LossFindingKind =
  /** Content vanished and the merge never said it did. The headline failure. */
  | "undeclared-removal"
  /** Block survived but its body was emptied out — deletion wearing a survivor's key. */
  | "emptied-block"
  /** A citation of this document at a locator no routed segment covers, coverage clean. */
  | "phantom-locator"
  /** The same, but the extraction dropped pages undeclared, so it cannot be adjudicated. */
  | "unverifiable-locator"
  /** A removal was declared for a block that was never there. Bookkeeping drift. */
  | "phantom-removal"
  /** Pages were routed to this topic and the produced page cites almost none of them. */
  | "uncited-routed-pages";

export type LossSeverity = "red" | "amber";

export interface LossFinding {
  readonly kind: LossFindingKind;
  readonly severity: LossSeverity;
  /** The block this is about, or the locator for the citation kinds. */
  readonly subject: string;
  /** One sentence, safe to put in front of a person. */
  readonly detail: string;
}

export interface LossDetectorInput {
  readonly before: TopicPageLike;
  readonly after: TopicPageLike;
  /** `removals` from the merge output. An empty list is a claim that nothing was dropped. */
  readonly removals?: readonly DeclaredRemoval[];
  /** The document being merged. Only citations naming THIS id are checkable here. */
  readonly documentId: string;
  /** Every page/slide covered by the segments routed to this topic. */
  readonly routedPages: readonly number[];
  /**
   * Pages the extraction lost without declaring them (`segmentExtraction`'s
   * `unaccountedPages`). Non-empty demotes `phantom-locator` to `unverifiable-locator`.
   */
  readonly unaccountedPages?: readonly number[];
  /** False when `sourceUnits` was unknown, so coverage could not be computed at all. */
  readonly coverageChecked?: boolean;
}

export interface LossDetectorResult {
  readonly findings: readonly LossFinding[];
  /** True when at least one `red` finding is present — the re-merge trigger. */
  readonly hasRedFlag: boolean;
  /** Convenience counts for the processing-event line. */
  readonly blocksBefore: number;
  readonly blocksAfter: number;
}

/** Citations that name this document, paired with the unit they point at. */
function citedUnits(sources: readonly BlockSourceLike[], documentId: string): readonly number[] {
  const units: number[] = [];
  for (const source of sources) {
    if (source.documentId !== documentId) continue;
    // Flat first (the live schema), nested second (anything stored by an earlier shape).
    const flat = source.page;
    const unit =
      typeof flat === "number" && Number.isFinite(flat) ? flat : locatorUnit(source.locator);
    // A citation with no page is a document-level claim, not a checkable one. Skipped
    // rather than treated as page 0 — see `locatorUnit`.
    if (unit !== null) units.push(unit);
  }
  return units;
}

/**
 * Diffs a pre-merge page against a proposed one and reports what was lost.
 *
 * Pure, total, and never throws: it is called on a model's output, so a malformed proposed
 * page must produce findings rather than an exception that fails the whole document. A
 * proposed page that parsed as `{}` flattens to zero blocks and every prior block is
 * reported as an undeclared removal, which is exactly the right answer.
 */
export function detectMergeLoss(input: LossDetectorInput): LossDetectorResult {
  const before = flattenTopicPage(input.before);
  const after = flattenTopicPage(input.after);
  const removals = input.removals ?? [];

  const afterByKey = new Map<string, DiffBlock>(after.map((block) => [block.key, block]));
  const beforeKeys = new Set(before.map((block) => block.key));
  const declared = new Set(removals.map((removal) => removal.blockKey));

  const findings: LossFinding[] = [];

  // ── 1. Blocks that vanished ────────────────────────────────────────────────
  for (const block of before) {
    if (afterByKey.has(block.key)) continue;
    if (declared.has(block.key)) continue;
    findings.push({
      kind: "undeclared-removal",
      severity: "red",
      subject: block.key,
      detail: `“${block.label}” was in the page before this merge and is gone from the proposed page, but the merge did not declare it superseded.`,
    });
  }

  // ── 2. Blocks that survived in name only ───────────────────────────────────
  //
  // A merger that keeps a heading and empties its body has removed the content while
  // leaving the key behind, which check 1 cannot see. Only flagged when there WAS content:
  // a block that was always empty is a pre-existing stub, not a loss caused here.
  for (const block of before) {
    const survivor = afterByKey.get(block.key);
    if (survivor === undefined) continue;
    if (block.text.length === 0) continue;
    if (survivor.text.length > 0) continue;
    findings.push({
      kind: "emptied-block",
      severity: "red",
      subject: block.key,
      detail: `“${block.label}” still exists but its content was emptied by this merge.`,
    });
  }

  // ── 3. Removals declared for blocks that were never there ──────────────────
  //
  // Amber, not red: nothing was lost. But it means the merger's idea of the page and the
  // page itself disagree, which is worth seeing before it becomes a real removal.
  for (const removal of removals) {
    if (beforeKeys.has(removal.blockKey)) continue;
    findings.push({
      kind: "phantom-removal",
      severity: "amber",
      subject: removal.blockKey,
      detail: `The merge declared it removed “${removal.blockKey}”, which was not in the page before the merge.`,
    });
  }

  // ── 4. Citations this document cannot support ──────────────────────────────
  const routed = new Set(input.routedPages);
  const unaccounted = new Set(input.unaccountedPages ?? []);
  const coverageChecked = input.coverageChecked ?? false;
  const reported = new Set<string>();

  for (const block of after) {
    for (const unit of citedUnits(block.sources, input.documentId)) {
      if (routed.has(unit)) continue;

      // Undeclared extraction loss makes this unadjudicable — the page may well have said
      // what the merger claims; the extraction simply never produced it.
      const lossy = unaccounted.has(unit) || !coverageChecked || unaccounted.size > 0;
      const kind: LossFindingKind = lossy ? "unverifiable-locator" : "phantom-locator";
      const subject = `${block.key}@${unit}`;
      if (reported.has(subject)) continue;
      reported.add(subject);

      findings.push({
        kind,
        severity: lossy ? "amber" : "red",
        subject,
        detail: lossy
          ? `“${block.label}” cites page ${unit} of this document, which no segment routed to this topic covers — and this document's extraction has pages it neither returned nor declared skipped, so the citation cannot be checked either way.`
          : `“${block.label}” cites page ${unit} of this document, but no segment routed to this topic covers that page.`,
      });
    }
  }

  // ── 5. Routed pages that the page never cites ──────────────────────────────
  //
  // Check 4 runs `cited ⊆ routed` and skips any unit already in `routed`, so it is
  // structurally incapable of noticing the opposite: pages that WERE routed to this topic
  // and that nothing on the produced page points at. That is the direction the Wave 4
  // failure ran in, and it is the direction that matters on a create — where checks 1–3
  // are inert by construction, because `before` is the empty page and every loop above
  // iterates an empty set.
  //
  // A ratio rather than a per-page rule, and a low floor. A topic fed five slides that
  // cites four of them is a normal merge and must not spend a second Sonnet call; a topic
  // fed forty-eight that cites one is the failure. The floor is set to separate those two
  // cases and nothing finer.
  // Scoped to the create path, and derived rather than passed: `EMPTY_TOPIC_PAGE` flattens
  // to zero blocks, so `before.length === 0` IS "this merge is writing the first version of
  // this page". Only then is every block on the page attributable to this document's
  // segments. On an update the page is mostly prior material and a low citation share
  // against one contribution means nothing — firing there would be a false accusation
  // costing a Sonnet re-merge.
  const isFirstVersion = before.length === 0;

  if (isFirstVersion && input.routedPages.length >= MIN_ROUTED_FOR_CITATION_CHECK) {
    const citedFromThisDocument = new Set<number>();
    for (const block of after) {
      for (const unit of citedUnits(block.sources, input.documentId)) {
        if (routed.has(unit)) citedFromThisDocument.add(unit);
      }
    }

    const share = citedFromThisDocument.size / routed.size;
    if (share < CITED_ROUTED_SHARE_FLOOR) {
      const uncited = [...routed]
        .filter((page) => !citedFromThisDocument.has(page))
        .sort((a, b) => a - b);
      findings.push({
        kind: "uncited-routed-pages",
        severity: "red",
        subject: `${uncited.length} of ${routed.size} pages`,
        detail: `${routed.size} pages of this document were routed to this topic, but the page only cites ${citedFromThisDocument.size} of them. Nothing on it points at page${uncited.length === 1 ? "" : "s"} ${uncited.slice(0, 10).join(", ")}${uncited.length > 10 ? "…" : ""} — that material was supplied and is not represented.`,
      });
    }
  }

  return {
    findings,
    hasRedFlag: findings.some((finding) => finding.severity === "red"),
    blocksBefore: before.length,
    blocksAfter: after.length,
  };
}
