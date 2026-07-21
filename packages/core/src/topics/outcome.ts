/**
 * Partial success as a first-class outcome (PLAN §7).
 *
 * > per-topic merge steps are isolated; one failed merge doesn't doom the document.
 * > `finalize` computes: all merges ok → `ready`; some failed → `partial` with the failed
 * > topic list stored; extraction itself failed → `failed`.
 *
 * A pure function because that sentence is a specification and specifications should be
 * testable without a database. `finalize` calls it with what actually happened and writes
 * the result; every interesting case — no topics at all, every topic failed, a mix — is
 * pinned here rather than discovered in production.
 *
 * ## The case worth naming: every merge failed
 *
 * "Some failed → partial" read literally makes an all-failed document `partial`, and that
 * is wrong in the way that matters to a person: `partial` means "usable, with gaps", and a
 * document that contributed nothing to any topic page is not usable. It is also exactly
 * what a systematic failure looks like — a bad prompt, an expired key, a provider outage —
 * so reporting it as a qualified success is how a broken pipeline stays quiet. The one
 * exception is a document that had **nothing to merge**: an extraction with no routable
 * segments succeeded at its job, so zero-of-zero is `ready`, not `failed`.
 */

/** Whatever happened to one topic's merge step. */
export type TopicMergeOutcome =
  | { readonly topicKey: string; readonly status: "merged"; readonly needsReview: boolean }
  | { readonly topicKey: string; readonly status: "failed"; readonly error: string };

/** One entry of `documents.failed_topics` — the retry set for `document/retry-merges`. */
export interface FailedTopic {
  readonly topicKey: string;
  readonly error: string;
}

/** The three terminal states of `document_status`. */
export type DocumentOutcomeStatus = "ready" | "partial" | "failed";

export interface DocumentOutcome {
  readonly status: DocumentOutcomeStatus;
  readonly failedTopics: readonly FailedTopic[];
  readonly mergedCount: number;
  readonly needsReviewCount: number;
}

export interface DocumentOutcomeInput {
  readonly topicOutcomes: readonly TopicMergeOutcome[];
  /**
   * True when at least one part of the run degraded without failing a topic outright —
   * PLAN §7's "embedding failures also degrade to `partial`". Kept as a flag rather than a
   * synthetic failed-topic entry because it is not a topic and must not enter the retry set.
   */
  readonly degraded?: boolean;
  /**
   * True when the coverage map came back `trustworthy: false` — content the student uploaded
   * did not demonstrably reach a topic page. On the wave7-section3 run this was the ONLY
   * honest signal that 4 of 8 planned topics had evaporated, yet the document still finalized
   * `ready` because this function never read coverage. Folded into the downgrade exactly like
   * {@link degraded}: it forces `partial`, it is not a topic, and it never enters the retry
   * set. The verdict lives in `documents.coverage.trustworthy` — there is no top-level column.
   */
  readonly coverageUntrustworthy?: boolean;
}

export function computeDocumentOutcome(input: DocumentOutcomeInput): DocumentOutcome {
  const outcomes = input.topicOutcomes;
  const failedTopics: FailedTopic[] = outcomes
    .filter(
      (outcome): outcome is Extract<TopicMergeOutcome, { status: "failed" }> =>
        outcome.status === "failed",
    )
    .map((outcome) => ({ topicKey: outcome.topicKey, error: outcome.error }));

  const merged = outcomes.filter((outcome) => outcome.status === "merged");
  const needsReviewCount = merged.filter(
    (outcome) => outcome.status === "merged" && outcome.needsReview,
  ).length;

  // The soft downgrades: non-topic reasons a clean run is still not a clean `ready`. Both
  // force `partial` and neither is a topic, so neither enters `failedTopics`. All-failed is
  // decided before this is consulted, so an untrustworthy map never upgrades `failed`.
  const softDowngrade = input.degraded === true || input.coverageUntrustworthy === true;

  const status: DocumentOutcomeStatus =
    // Nothing to merge is a successful no-op, not a failure. See the module note.
    outcomes.length === 0
      ? softDowngrade
        ? "partial"
        : "ready"
      : failedTopics.length === outcomes.length
        ? "failed"
        : failedTopics.length > 0 || softDowngrade
          ? "partial"
          : "ready";

  return {
    status,
    failedTopics,
    mergedCount: merged.length,
    needsReviewCount,
  };
}

/**
 * The user-facing sentence for a non-`ready` outcome.
 *
 * Lives here, next to the decision, so `documents.failure_reason` cannot drift from the
 * status it explains — and so it stays a sentence rather than an error string. §8 forbids
 * raw error text in this column; the per-topic errors are in `failed_topics` for the retry
 * job and in the processing feed for a human, neither of which is a headline.
 */
export function outcomeMessage(outcome: DocumentOutcome): string | null {
  if (outcome.status === "ready") return null;

  const count = outcome.failedTopics.length;
  if (outcome.status === "failed") {
    return count === 0
      ? "This file was read, but none of its material could be written into your topic pages. Try again."
      : `This file was read, but none of its ${count} topic${count === 1 ? "" : "s"} could be updated. Try again.`;
  }

  return count === 0
    ? "Your topic pages were updated, but part of the indexing didn’t finish. The pages are readable; search may lag."
    : `Your topic pages were updated, except for ${count} of them. Retry to finish the rest.`;
}
