/**
 * The pure pieces of exam-review generation (PLAN §9): rendering the topic index the prompt
 * reads, and building the `topic_snapshot` the review is stamped with.
 *
 * These are split out of `functions/generate-review.ts` for the same reason the topic-page
 * view model is split out of its route: the interesting logic — what the model is shown, and
 * the exact shape of the snapshot the staleness job later reads — has to be unit-testable
 * without an Inngest run or a database. The function file does the I/O; this decides what the
 * fetched rows mean.
 */

import type { StoredTopicPage } from "@study/ai";

/** One topic, digested down to what the exam-review prompt is shown. */
export interface ReviewTopic {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  /** `exam_weight_override ?? exam_weight` — the effective weight §9 prioritises on. */
  readonly effectiveWeight: number;
  readonly page: StoredTopicPage;
}

/**
 * One `(topicId, revision)` pair for `exam_reviews.topic_snapshot`.
 *
 * ⚠ The key is `topicId`, and that is a contract with `mark-reviews-stale.readSnapshot`, which
 * accepts `topicId` (or `topic_id`) + a numeric `revision`. A drift here marks every review it
 * writes permanently stale, because a snapshot `readSnapshot` cannot parse is treated as "cannot
 * prove fresh" → stale. `generate-review.contract.test.ts` pins the two together.
 */
export interface ReviewSnapshotPair {
  readonly topicId: string;
  readonly revision: number;
}

/**
 * The snapshot a review is built from: every topic it covered, at the revision it was covered
 * at. `isReviewStale` compares this pair-by-pair against current revisions, so a review is
 * stale exactly when one of these topics has moved past the recorded revision (or vanished).
 */
export function buildReviewSnapshot(
  topics: readonly { readonly id: string; readonly revision: number }[],
): ReviewSnapshotPair[] {
  return topics.map((topic) => ({ topicId: topic.id, revision: topic.revision }));
}

/** A weight band label, mirroring the prompt's thresholds, so the index states it in words too. */
function weightBand(weight: number): string {
  if (weight >= 0.6) return "HIGH";
  if (weight >= 0.35) return "MID";
  return "LOW";
}

function renderList(items: readonly string[], empty: string): string {
  const cleaned = items.map((item) => item.trim()).filter((item) => item !== "");
  return cleaned.length === 0 ? empty : cleaned.join("; ");
}

/**
 * One topic's block in the index. The exam weight is stated as a number AND a band because the
 * prompt keys section depth off it — ordering alone would let the model treat every topic
 * equally and still call the result "prioritised".
 */
function renderTopic(topic: ReviewTopic): string {
  const { page } = topic;
  return [
    `[topic-id: ${topic.id}] ${topic.title}`,
    `  exam weight: ${topic.effectiveWeight.toFixed(2)} (${weightBand(topic.effectiveWeight)})`,
    `  summary: ${topic.summary.trim() === "" ? "(none)" : topic.summary.trim()}`,
    `  formulas: ${renderList(
      page.formulas.map((formula) => `${formula.name} = ${formula.latex}`),
      "none",
    )}`,
    `  key terms: ${renderList(
      page.keyTerms.map((term) => term.term),
      "none",
    )}`,
    `  worked examples: ${renderList(
      page.workedExamples.map((example) => example.problem),
      "none",
    )}`,
    `  open questions: ${renderList(
      page.openQuestions.map(
        (question) => `[${question.kind}] ${question.question} — ${question.context}`,
      ),
      "none",
    )}`,
  ].join("\n");
}

/**
 * The whole topic index, topics in the order given (the caller sorts by effective weight, so
 * the model sees the highest-weight topics first).
 */
export function renderTopicIndex(topics: readonly ReviewTopic[]): string {
  if (topics.length === 0) return "(this course has no topics yet)";
  return topics.map(renderTopic).join("\n\n");
}

/**
 * `courses.exam_format_profile` (freeform jsonb) rendered as text the prompt can read. A course
 * that never recorded one gets an honest default rather than an empty section — M1 reviews
 * generate without the planner's `exams` row (§9), so this is often the only format hint there
 * is.
 */
export function renderExamFormat(profile: unknown): string {
  if (profile === null || profile === undefined) {
    return "No exam-format profile recorded for this course — assume a standard written final exam covering the whole course.";
  }
  if (typeof profile === "string") {
    return profile.trim() === "" ? "No exam-format profile recorded for this course." : profile;
  }
  if (typeof profile === "object") {
    const entries = Object.entries(profile as Record<string, unknown>);
    if (entries.length === 0) return "No exam-format profile recorded for this course.";
    return entries
      .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join("\n");
  }
  return String(profile);
}
