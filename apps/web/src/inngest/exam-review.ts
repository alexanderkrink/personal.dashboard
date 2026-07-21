/**
 * The testable core of exam-review generation (PLAN §9): rendering the topic index the prompt
 * reads, building the `topic_snapshot` the review is stamped with, the budget/clamp gate, and
 * the one billed Opus call with its retry-safety guard.
 *
 * These are split out of `functions/generate-review.ts` for the same reason the topic-page
 * view model is split out of its route: the interesting logic — what the model is shown, the
 * exact shape of the snapshot the staleness job later reads, and (the money-critical part) the
 * gate that defers instead of paying and the guard that stops an Inngest retry re-billing Opus
 * — all have to be unit-testable without an Inngest run or a real provider. The function file
 * does the I/O and step orchestration; this decides what the fetched rows mean and owns the
 * billing invariants. See `exam-review.test.ts`.
 */

import {
  AIPausedError,
  type AIRuntime,
  EXAM_REVIEW_SYSTEM,
  type ExamReview,
  examReviewPrompt,
  examReviewSchema,
  type StoredTopicPage,
} from "@study/ai";
import { NonRetriableError } from "inngest";

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
 * prove fresh" → stale. `exam-review.test.ts` pins the two together against the real
 * `readSnapshot`.
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

/* ────────────────────────────────────────────────────────────────────────── */
/* The budget/clamp gate and the one billed Opus call                         */
/* ────────────────────────────────────────────────────────────────────────── */

/** `exam-review` is pinned to a deep-rank model (Opus); anything lower means AI_MAX_TIER clamped it. */
export const REQUIRED_REVIEW_RANK = "deep";

/** The subset of the runtime the review path needs, so tests can pass a fake. */
export type ExamReviewRuntime = Pick<AIRuntime, "resolve" | "guardCheck" | "generateStructured">;

export type ReviewGateResult =
  | { readonly allowed: true }
  /** `clamp` = AI_MAX_TIER forced exam-review below Opus; `budget` = the §6 guard is deferring. */
  | { readonly allowed: false; readonly cause: "clamp" | "budget"; readonly detail: string };

/**
 * The two checks that must pass before a review may be generated, shared by the Server Action
 * (which surfaces the result to the clicking student synchronously) and the Inngest function
 * (which must not spend when it fails).
 *
 * 1. **Clamp** — `exam-review` resolving below `deep` means `AI_MAX_TIER` has taken it off Opus.
 *    Generating anyway would hand the student a quietly worse review with no signal, so a clamp
 *    defers. Detected by rank, never by naming a model id (rank is exactly the clamp axis).
 * 2. **Budget** — past 100% of budget the §6 guard defers deep-rank background work. Consulted
 *    here so a deferred job is reported cleanly rather than throwing a retryable error later.
 */
export async function reviewGate(
  runtime: Pick<AIRuntime, "resolve" | "guardCheck">,
): Promise<ReviewGateResult> {
  if (runtime.resolve("exam-review").rank !== REQUIRED_REVIEW_RANK) {
    return {
      allowed: false,
      cause: "clamp",
      detail: "AI_MAX_TIER has clamped exam-review off its Opus tier.",
    };
  }
  const decision = await runtime.guardCheck("exam-review", "background");
  if (!decision.allowed) {
    return { allowed: false, cause: "budget", detail: decision.reason };
  }
  return { allowed: true };
}

/** The five-column stamp the review row carries, lifted off the runtime's result. */
export interface ReviewStamp {
  readonly promptId: string;
  readonly promptVersion: number;
  readonly provider: string;
  readonly model: string;
  readonly inputHash: string;
}

export type ExamReviewContentResult =
  | { readonly kind: "generated"; readonly content: ExamReview; readonly stamp: ReviewStamp }
  | {
      readonly kind: "deferred";
      readonly cause: "clamp" | "budget" | "paused" | "unconfigured";
      readonly detail: string;
    }
  | { readonly kind: "dead-letter"; readonly message: string };

/**
 * The one billed Opus call, with its two money guards. Returns a value rather than throwing for
 * every *expected* outcome (deferred, dead-letter) — a caller in an Inngest step branches on it.
 *
 * ## 🔴 The retry double-bill guard (the invariant this function owns)
 *
 * `generateStructured` is NOT idempotent: each call meters and bills its attempts. So if it
 * throws anything other than `AIPausedError`, the paid provider call has (or may have) already
 * happened, and letting that error propagate as a normal `Error` would fail the Inngest step,
 * which Inngest then RETRIES — re-running the paid call and **doubling** the ~$0.50–1.50 bill.
 *
 * The rule, therefore:
 * - `AIPausedError` → the call never ran (kill switch / budget), so nothing was spent: return
 *   `deferred`. Safe to try again later; not a failure.
 * - **Any other error** (429 / transport / auth, which the structured ladder re-throws) → the
 *   spend already happened, so this MUST NOT be retried: rethrow as `NonRetriableError`. One
 *   logical generation bills at most one Opus call, even across an Inngest retry.
 */
export async function generateExamReviewContent(deps: {
  readonly runtime: ExamReviewRuntime;
  readonly courseTitle: string;
  readonly examFormat: string;
  readonly topics: readonly ReviewTopic[];
}): Promise<ExamReviewContentResult> {
  const gate = await reviewGate(deps.runtime);
  if (!gate.allowed) {
    return { kind: "deferred", cause: gate.cause, detail: gate.detail };
  }

  try {
    const result = await deps.runtime.generateStructured({
      job: "exam-review",
      prompt: examReviewPrompt,
      system: EXAM_REVIEW_SYSTEM,
      schema: examReviewSchema,
      kind: "background",
      vars: {
        courseTitle: deps.courseTitle,
        examFormat: deps.examFormat,
        topicIndex: renderTopicIndex(deps.topics),
      },
    });

    if (result.status === "dead-letter") {
      return { kind: "dead-letter", message: result.message };
    }
    return {
      kind: "generated",
      content: result.value,
      stamp: {
        promptId: result.stamp.promptId,
        promptVersion: result.stamp.promptVersion,
        provider: result.stamp.provider,
        model: result.stamp.model,
        inputHash: result.stamp.inputHash,
      },
    };
  } catch (error) {
    if (error instanceof AIPausedError) {
      // Paused between the gate and the call (TOCTOU). The call never ran → no spend → deferrable.
      return { kind: "deferred", cause: "paused", detail: error.reason };
    }
    // Everything else happened after the paid call. Non-retriable, or Inngest re-bills Opus.
    throw new NonRetriableError(
      `exam-review generation failed after the model call and must not be retried to avoid a double bill: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
