/**
 * Whether a topic still needs this document merged into it (PLAN §5, "Idempotency &
 * re-processing").
 *
 * ## What this replaces, and what it does NOT
 *
 * PLAN §5 promises a *strip*: re-processing a document first replays every topic it touched
 * forward from the `topic_revisions` snapshot taken before that document's first merge,
 * re-applying only the revisions from other documents, then deletes the document's
 * `topic_sources` rows and chunks and runs fresh. **That strip is still unbuilt.** PLAN is
 * marked 🔴 DISPROVEN 2026-07-20 and this module is the narrower fix that stops the bleeding:
 * instead of undoing a prior contribution so it can be redone, it *recognises* a prior
 * contribution and declines to make a second one.
 *
 * The difference is real and worth stating: with the strip, re-processing a document whose
 * bytes were re-extracted differently produces a page rebuilt from the new extraction. With
 * only this, it produces the page it already had. That is the right trade for the two
 * triggers that exist today — the "Retry the rest" button and an Inngest step retry landing
 * mid-loop — because both of those want the *unfinished* topics finished, not the finished
 * ones redone. It is the wrong trade for a genuine "Reprocess", which is why the strip is
 * still owed.
 *
 * ## Why the decision needs two witnesses
 *
 * Step C persists a topic in three writes — snapshot, page update, provenance — and PostgREST
 * has no transaction to wrap them in. So "has this document already been merged into this
 * topic?" has to be answered from whichever prefix of those three landed:
 *
 * | Snapshot | `topics.revision` | `topic_sources` | Verdict |
 * | --- | --- | --- | --- |
 * | absent | — | absent | never merged → **merge** |
 * | absent | — | present | topic was CREATED by this document (the create path writes no snapshot) → **skip** |
 * | at R | still R | either | the page update never landed → **merge** (the snapshot re-insert is a harmless duplicate) |
 * | at R | past R | either | the page update landed → **skip** |
 *
 * The row that is missing in the third case is exactly the one a crash between write 1 and
 * write 2 leaves behind, and the row that is missing in the fourth is what a crash between
 * write 2 and write 3 leaves behind. Reading only `topic_sources` would re-merge the fourth
 * case; reading only the snapshot would skip the third and silently lose a merge.
 *
 * Pure, and deliberately so — no I/O, no clock, no Supabase types. Every row above is a
 * table-driven test rather than a production discovery.
 */

/** What the database already knows about this document's effect on one topic. */
export interface PriorContribution {
  readonly topicId: string;
  /**
   * `topic_revisions.revision` of this document's `source = 'merge'` snapshot for this
   * topic, or `null` when there is none. Null does not mean "not merged" — the create path
   * writes no snapshot at all — which is why `hasProvenance` exists alongside it.
   */
  readonly snapshotRevision: number | null;
  /** Whether a `topic_sources` row exists for this (topic, document) pair. */
  readonly hasProvenance: boolean;
}

/** The minimum a merge target must expose for this decision. Structural, so callers keep their own type. */
export interface MergeTargetLike {
  /** Null when this merge would CREATE the topic — nothing can have been merged into it yet. */
  readonly topicId: string | null;
  /** Stable id for logging and for `failed_topics`. */
  readonly topicKey: string;
  readonly title: string;
  /** `topics.revision` as read at the start of this pass. */
  readonly currentRevision: number;
}

/** A target that was already merged, and the revision the earlier merge left the topic at. */
export interface SkippedTarget {
  readonly topicId: string;
  readonly topicKey: string;
  readonly title: string;
  /**
   * The `topics.revision` value the earlier merge produced — what `topic_sources
   * .merged_at_revision` should hold. Carried so the caller can repair a provenance row that
   * a crash left unwritten without having to re-derive it.
   */
  readonly mergedAtRevision: number;
  /** True when the `topic_sources` row is missing and the caller should write it. */
  readonly provenanceMissing: boolean;
}

export interface MergePlan<T extends MergeTargetLike> {
  /** Targets that still need the merge + critic calls. */
  readonly toMerge: readonly T[];
  /** Targets this document is already merged into. No LLM call, no revision bump. */
  readonly skipped: readonly SkippedTarget[];
}

export interface PlanMergeWorkInput<T extends MergeTargetLike> {
  readonly targets: readonly T[];
  readonly priorContributions: readonly PriorContribution[];
}

/**
 * Splits this pass's merge targets into "still owed" and "already done".
 *
 * On a first run `priorContributions` is empty and every target is owed, so this costs
 * nothing in the common case. On a re-run it is what makes the pass converge: the topics
 * that persisted last time are skipped whole — no merge call, no critic call, no snapshot,
 * no `revision` bump — and only the ones that did not persist are paid for again.
 */
export function planMergeWork<T extends MergeTargetLike>(
  input: PlanMergeWorkInput<T>,
): MergePlan<T> {
  const priorByTopic = new Map(input.priorContributions.map((prior) => [prior.topicId, prior]));

  const toMerge: T[] = [];
  const skipped: SkippedTarget[] = [];

  for (const target of input.targets) {
    const topicId = target.topicId;
    // A create has no topic to have contributed to. It is always owed — and if the topic it
    // would create already exists from an earlier pass, routing sees it in the index and the
    // duplicate guard coerces the proposal onto it, which lands back in the branch below.
    if (topicId === null) {
      toMerge.push(target);
      continue;
    }

    const prior = priorByTopic.get(topicId);
    if (prior === undefined) {
      toMerge.push(target);
      continue;
    }

    if (prior.snapshotRevision === null) {
      // No snapshot but provenance exists → this document CREATED the topic. Already done.
      // No snapshot and no provenance → nothing is known; merge.
      if (prior.hasProvenance) {
        skipped.push({
          topicId,
          topicKey: target.topicKey,
          title: target.title,
          mergedAtRevision: target.currentRevision,
          provenanceMissing: false,
        });
      } else {
        toMerge.push(target);
      }
      continue;
    }

    // A snapshot holds the page BEFORE its merge, so that merge intended to leave the topic
    // at `snapshotRevision + 1`. If the topic is still sitting at `snapshotRevision`, the
    // page update never landed and the merge is genuinely unfinished.
    if (target.currentRevision <= prior.snapshotRevision) {
      toMerge.push(target);
      continue;
    }

    skipped.push({
      topicId,
      topicKey: target.topicKey,
      title: target.title,
      mergedAtRevision: prior.snapshotRevision + 1,
      provenanceMissing: !prior.hasProvenance,
    });
  }

  return { toMerge, skipped };
}
