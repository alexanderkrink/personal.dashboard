/**
 * Removing one document's contribution from the topic pages it was merged into
 * (PLAN §5, "Idempotency & re-processing" — the *strip*).
 *
 * ## ⚠ CORRECTED 2026-07-20 — this strips by BLOCK PROVENANCE, not by snapshot replay
 *
 * PLAN §5 specifies the strip as a replay: "`topic_revisions` stores the full pre-merge
 * `TopicPage` snapshot for every revision, so the strip replays the topic forward from the
 * snapshot taken before this document's first merge, re-applying only the revisions from
 * *other* documents". That mechanism is **not** what this module implements, and the
 * divergence is deliberate. Three measured reasons, in order of weight:
 *
 * 1. **There is nothing to replay from.** `topic_revisions` held 0 rows on the production
 *    database when this was written, against 2 live topics — because the *create* path
 *    writes no snapshot at all (`reprocess.ts` documents this: "topic was CREATED by this
 *    document (the create path writes no snapshot)"). A replay-forward strip is undefined
 *    for every topic that exists today. It is a mechanism for a history that is not
 *    recorded.
 * 2. **Replay is only exact when this document merged last.** A snapshot stores the whole
 *    page *before* a revision, not that revision's delta. Re-applying a later document's
 *    revision onto a base that no longer contains this document's text is a three-way merge
 *    of LLM-authored prose — §5 never says how to perform it, and there is no deterministic
 *    answer. §5 calls the strip "deterministic, not an LLM call"; snapshot replay only
 *    satisfies that claim in the last-contributor case.
 * 3. **Block provenance is exact, and it is already there.** Every block family on a
 *    `TopicPage` carries `sources: [{documentId, page}]` (see `BlockSourceLike` in
 *    `./page`). Verified on real data: all 9 blocks across both live topics carry a
 *    `documentId`. So "which blocks came from this document" is a lookup, not an inference
 *    — no base page, no revision ordering, and no model in the path. That is *more*
 *    deterministic than the mechanism §5 specifies, and it works per-block rather than
 *    per-revision, so a topic built by three documents loses exactly one third.
 *
 * The property §5 actually wants — "the topic ends up as if this document had never been
 * merged" — is what this delivers. The route it takes there is different, and this note is
 * the record of that, extending the 🔴 DISPROVEN / ⚠ CORRECTED block already in §5.
 *
 * ## What it deliberately CANNOT remove, and why that is reported rather than guessed
 *
 * Two things on a page carry no provenance and are therefore left standing:
 *
 * - **`page.summary`** — a prose paragraph with no `sources` field at all. It was written
 *   by a merge that saw this document's content, so it may describe material that is about
 *   to be removed. Nothing in the data says which sentence came from where.
 * - **A block with no attributable source** — an empty or absent `sources` array, or one
 *   whose entries carry no `documentId`. An older merge, or a model that omitted the field.
 *
 * Both are **counted and returned** so the caller can say so out loud. The rule throughout
 * is conservative: a block is removed only when *every* one of its sources is this
 * document. A block with even one source pointing elsewhere — or pointing nowhere — is
 * kept, because the cost of wrongly keeping a block is a stale paragraph and the cost of
 * wrongly removing one is another document's content silently disappearing.
 *
 * Pure: no I/O, no clock, no Supabase types, no `process.env`.
 */

import type { BlockSourceLike, TopicPageLike } from "./page";

/** The five block families that carry `sources`. */
export type StripBlockKind = "notes" | "keyTerms" | "formulas" | "workedExamples" | "openQuestions";

const BLOCK_KINDS: readonly StripBlockKind[] = [
  "notes",
  "keyTerms",
  "formulas",
  "workedExamples",
  "openQuestions",
];

/** How many blocks of each family the strip removed. */
export type StripCounts = Readonly<Record<StripBlockKind, number>>;

const ZERO_COUNTS: StripCounts = {
  notes: 0,
  keyTerms: 0,
  formulas: 0,
  workedExamples: 0,
  openQuestions: 0,
};

/** Anything with an optional `sources` array — every block family qualifies structurally. */
interface SourcedLike {
  readonly sources?: readonly BlockSourceLike[] | null;
}

/**
 * One block's verdict.
 *
 * `"remove"` requires positive proof: at least one source, and *every* source naming this
 * document. Everything else keeps the block — `"unattributed"` records that we could not
 * tell, which is a different fact from "it belongs to someone else" and is reported
 * separately.
 */
type BlockVerdict = "remove" | "keep" | "unattributed";

function verdictFor(block: SourcedLike, documentId: string): BlockVerdict {
  const sources = block.sources ?? [];
  if (sources.length === 0) return "unattributed";

  let sawThisDocument = false;
  let sawOther = false;
  let sawUnattributed = false;

  for (const source of sources) {
    const id = source.documentId;
    if (id === null || id === undefined || id === "") {
      sawUnattributed = true;
    } else if (id === documentId) {
      sawThisDocument = true;
    } else {
      sawOther = true;
    }
  }

  // Every source is this document, and there is at least one. The only removable case.
  if (sawThisDocument && !sawOther && !sawUnattributed) return "remove";
  // Another document supports this block too — it survives the strip on that document's
  // account, and only this document's provenance entries come off.
  if (sawOther) return "keep";
  // Sources exist but none can be attributed to anyone.
  return "unattributed";
}

/** Drops this document's entries from a surviving block's `sources`, preserving order. */
function pruneSources(
  sources: readonly BlockSourceLike[] | null | undefined,
  documentId: string,
): readonly BlockSourceLike[] | null | undefined {
  if (sources === null || sources === undefined) return sources;
  const kept = sources.filter((source) => source.documentId !== documentId);
  return kept.length === sources.length ? sources : kept;
}

/** What one page's strip produced. */
export interface PageStripResult {
  /** The page with this document's blocks gone. Key-for-key the same shape as the input. */
  readonly page: TopicPageLike;
  /** Blocks removed, by family. */
  readonly removed: StripCounts;
  /** Total blocks removed across all families. */
  readonly removedTotal: number;
  /**
   * Blocks kept because nothing in them could be attributed to any document. Reported, not
   * hidden — see the module note.
   */
  readonly unattributedKept: number;
  /**
   * True when the page still carries a `summary` and the strip removed something. The
   * summary was written against content that is now gone, and no data says which part.
   */
  readonly summaryPossiblyStale: boolean;
  /** True when the strip changed anything at all (blocks removed or provenance pruned). */
  readonly changed: boolean;
}

/**
 * Removes every block that belongs solely to `documentId` from one topic page.
 *
 * Absent keys stay absent — a page stored as a bare `{}` (the `jsonb not null default '{}'`
 * case) comes back as `{}` rather than as five empty arrays, so this never fabricates
 * structure a topic did not have.
 */
export function stripDocumentFromPage(input: {
  readonly page: TopicPageLike;
  readonly documentId: string;
}): PageStripResult {
  const { page, documentId } = input;

  /**
   * Seeded from the stored page rather than built up field by field, so a key this module
   * does not know about survives the round trip. `topics.page` is `jsonb` — a future field,
   * or one written by a newer schema than this build, must not be silently dropped by a
   * delete. Only the five block families below are then overwritten.
   */
  const next: Record<string, unknown> = { ...page };

  const removed: Record<StripBlockKind, number> = { ...ZERO_COUNTS };
  let unattributedKept = 0;
  let changed = false;

  for (const kind of BLOCK_KINDS) {
    if (!(kind in page)) continue;

    const blocks = page[kind];
    if (blocks === null || blocks === undefined) {
      // Preserve an explicit null rather than turning it into an empty array.
      next[kind] = blocks;
      continue;
    }

    const kept: SourcedLike[] = [];
    for (const block of blocks) {
      const verdict = verdictFor(block, documentId);
      if (verdict === "remove") {
        removed[kind] += 1;
        changed = true;
        continue;
      }
      if (verdict === "unattributed") unattributedKept += 1;

      const prunedSources = pruneSources(block.sources, documentId);
      if (prunedSources !== block.sources) {
        changed = true;
        kept.push({ ...block, sources: prunedSources });
      } else {
        kept.push(block);
      }
    }

    next[kind] = kept;
  }

  const removedTotal = BLOCK_KINDS.reduce((sum, kind) => sum + removed[kind], 0);
  const summary = next.summary;
  const hasSummary = typeof summary === "string" && summary.trim().length > 0;

  return {
    // Safe by construction: every key came from `page`, and the five that were replaced hold
    // subsets of their own original elements with at most a narrowed `sources` array.
    page: next as TopicPageLike,
    removed,
    removedTotal,
    unattributedKept,
    summaryPossiblyStale: hasSummary && removedTotal > 0,
    changed,
  };
}

/** One topic as the strip needs to see it. Structural, so the caller keeps its own row type. */
export interface TopicStripTargetLike {
  readonly topicId: string;
  readonly title: string;
  readonly page: TopicPageLike;
  /**
   * The document ids of every `topic_sources` row on this topic, **including** the document
   * being deleted. The planner subtracts it itself, so the caller passes what the table
   * says rather than pre-filtering — one fewer place to get the subtraction wrong.
   */
  readonly sourceDocumentIds: readonly string[];
}

/** What should happen to one topic. */
export type TopicStripVerdict =
  | {
      /**
       * This document was the topic's only source. Nothing of it would survive the strip,
       * so the topic itself goes.
       *
       * Note the caller does **not** have to act on this: `topic_sources` cascades from
       * `documents`, and the `topic_sources_delete_sourceless_topic` trigger removes a topic
       * whose last source row went with it. This verdict exists so the confirmation dialog
       * can say how many topics will disappear *before* the delete runs.
       */
      readonly kind: "remove-topic";
      readonly topicId: string;
      readonly title: string;
    }
  | {
      /** Other documents also feed this topic. It survives, minus this document's blocks. */
      readonly kind: "rewrite-page";
      readonly topicId: string;
      readonly title: string;
      readonly page: TopicPageLike;
      readonly result: PageStripResult;
    }
  | {
      /** Survives untouched — this document contributed no attributable block to it. */
      readonly kind: "unchanged";
      readonly topicId: string;
      readonly title: string;
    };

/** The whole plan, plus the counts the confirmation dialog needs. */
export interface DocumentStripPlan {
  readonly verdicts: readonly TopicStripVerdict[];
  /** Topics that disappear entirely. */
  readonly topicsRemoved: number;
  /** Topics that survive with a rewritten page. */
  readonly topicsRewritten: number;
  /** Blocks removed from surviving topics. Blocks inside removed topics are not counted here. */
  readonly blocksRemoved: number;
  /** Blocks left standing on surviving topics because nothing attributed them. */
  readonly blocksUnattributed: number;
  /** Surviving topics whose summary paragraph may now describe removed content. */
  readonly staleSummaries: number;
}

/**
 * Decides, for every topic this document was merged into, what the delete should do to it.
 *
 * Pure and total: hand it the rows, get the plan. Nothing here writes, and nothing here
 * needs to know whether the caller is a Server Action or a background job.
 */
export function planDocumentStrip(input: {
  readonly documentId: string;
  readonly topics: readonly TopicStripTargetLike[];
}): DocumentStripPlan {
  const { documentId, topics } = input;

  const verdicts: TopicStripVerdict[] = [];
  let topicsRemoved = 0;
  let topicsRewritten = 0;
  let blocksRemoved = 0;
  let blocksUnattributed = 0;
  let staleSummaries = 0;

  for (const topic of topics) {
    const others = topic.sourceDocumentIds.filter((id) => id !== documentId);

    if (others.length === 0) {
      verdicts.push({ kind: "remove-topic", topicId: topic.topicId, title: topic.title });
      topicsRemoved += 1;
      continue;
    }

    const result = stripDocumentFromPage({ page: topic.page, documentId });
    if (!result.changed) {
      verdicts.push({ kind: "unchanged", topicId: topic.topicId, title: topic.title });
      continue;
    }

    verdicts.push({
      kind: "rewrite-page",
      topicId: topic.topicId,
      title: topic.title,
      page: result.page,
      result,
    });
    topicsRewritten += 1;
    blocksRemoved += result.removedTotal;
    blocksUnattributed += result.unattributedKept;
    if (result.summaryPossiblyStale) staleSummaries += 1;
  }

  return {
    verdicts,
    topicsRemoved,
    topicsRewritten,
    blocksRemoved,
    blocksUnattributed,
    staleSummaries,
  };
}
