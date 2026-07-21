/**
 * `generate-review` — the on-demand half of PLAN §9: one Opus call per course that turns the
 * course's topic pages and exam weights into an `exam_reviews` row.
 *
 * The staleness half already exists (`mark-reviews-stale`); this is its counterpart, the
 * consumer of `course/review.requested`. §9 is explicit that generation is **on demand, not
 * automatic** — reviews cost ~$0.50–1.50 on Opus and a student regenerates near an exam — so
 * nothing enqueues this except the Regenerate button's Server Action.
 *
 * ## The three things this function must not do
 *
 *  1. **Double-bill.** A double-click, or a click while a run is in flight, must not produce
 *     two Opus calls. `concurrency: [{ key: courseId, limit: 1 }]` serializes runs for a
 *     course, and the freshness check then makes the second run a no-op: run 1 inserts a
 *     review whose snapshot matches the current topics, run 2 sees a non-stale review and
 *     skips. The two together are the dedupe.
 *  2. **Silently produce a non-Opus review.** `exam-review` is a deep-rank job pinned to Opus.
 *     If `AI_MAX_TIER` has clamped it down a rank, generating anyway would hand the student a
 *     quietly worse review with no signal that it happened — so the clamp is detected (the
 *     resolved rank is no longer `deep`) and the run defers instead.
 *  3. **Hang under budget pressure.** Past 100% of budget the §6 guard defers deep-rank
 *     background jobs. Rather than call `generateStructured` and let it throw a retryable
 *     `AIPausedError` that burns the retry budget, the guard is consulted first and the run
 *     returns a `deferred` status. The Regenerate Server Action surfaces the same state to the
 *     student synchronously, so they see "paused", not a spinner.
 *
 * Rule 8 (`events.ts`): the owner is derived from the `courses` row, never from the payload —
 * the event carries only `courseId`.
 */

import {
  AIPausedError,
  EXAM_REVIEW_SYSTEM,
  type ExamReview,
  examReviewPrompt,
  examReviewSchema,
  storedTopicPageSchema,
} from "@study/ai";
import type { Json } from "@study/db";
import { NonRetriableError } from "inngest";
import { inngest } from "@/inngest/client";
import { adminClient } from "@/inngest/documents";
import { courseReviewRequested, courseReviewRequestedData } from "@/inngest/events";
import {
  buildReviewSnapshot,
  type ReviewTopic,
  renderExamFormat,
  renderTopicIndex,
} from "@/inngest/exam-review";
import { isReviewStale, readSnapshot } from "@/inngest/functions/mark-reviews-stale";
import { deriveOwner } from "@/inngest/owner";
import { AINotConfiguredError, createStudyAIRuntime } from "@/lib/ai/runtime";

/** One topic as loaded for the review, carried between steps (JSON-safe). */
interface LoadedTopic {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly revision: number;
  readonly effectiveWeight: number;
  readonly page: ReturnType<typeof storedTopicPageSchema.parse>;
}

/** The `exam-review` job runs on a deep-rank model (Opus); anything lower is a clamp. */
const REQUIRED_RANK = "deep";

export const generateReview = inngest.createFunction(
  {
    id: "generate-review",
    // ⚠ v4: triggers live in the options object, like every other function here.
    triggers: [courseReviewRequested],
    // A user-initiated regeneration: a transient DB blip should retry, but not forever.
    retries: 2,
    // Serialized per course — this is half of the double-bill guard (see the header).
    concurrency: [{ key: "event.data.courseId", limit: 1 }],
  },
  async ({ event, step }) => {
    const parsed = courseReviewRequestedData.safeParse(event.data);
    if (!parsed.success) {
      throw new NonRetriableError(
        `Malformed course/review.requested event: ${parsed.error.message}`,
      );
    }
    const { courseId } = parsed.data;

    // Rule 8: owner from the database row the event points at, never from the payload.
    const { userId } = await step.run("derive-owner", () =>
      deriveOwner(adminClient(), { table: "courses", id: courseId }, { job: "generate-review" }),
    );

    // ── Load the course and its topics ─────────────────────────────────────────
    const loaded = await step.run("load-course", async () => {
      const admin = adminClient();

      const { data: course, error: courseError } = await admin
        .from("courses")
        .select("title, exam_format_profile")
        .eq("id", courseId)
        .eq("user_id", userId)
        .single();
      if (courseError !== null) {
        throw new Error(`Could not load course ${courseId}: ${courseError.message}`);
      }

      const { data: topicRows, error: topicError } = await admin
        .from("topics")
        .select("id, title, summary, page, exam_weight, exam_weight_override, revision")
        .eq("user_id", userId)
        .eq("course_id", courseId);
      if (topicError !== null) {
        throw new Error(`Could not load topics for course ${courseId}: ${topicError.message}`);
      }

      const topics: LoadedTopic[] = (topicRows ?? [])
        .map((row) => ({
          id: row.id,
          title: row.title,
          summary: row.summary,
          revision: row.revision,
          // §9(d): the effective weight the review prioritises on is `override ?? computed`.
          // This function only READS the override — it never writes it.
          effectiveWeight: row.exam_weight_override ?? row.exam_weight,
          page: storedTopicPageSchema.parse(row.page ?? {}),
        }))
        // Highest exam weight first — §9's prioritisation, made visible to the model by order.
        .sort((a, b) => b.effectiveWeight - a.effectiveWeight);

      return {
        courseTitle: course.title,
        examFormat: renderExamFormat(course.exam_format_profile),
        topics,
      };
    });

    // A course with no topics has nothing to review — return rather than spend on emptiness.
    if (loaded.topics.length === 0) {
      return { courseId, status: "empty" as const };
    }

    // ── Freshness guard (dedupe half 2) ────────────────────────────────────────
    //
    // If the newest review is still fresh against the current topic revisions, nothing has
    // changed since it was built, so regenerating would spend Opus to produce the same review.
    // Serialized behind `concurrency: 1`, this is what makes a double-click cost one call: the
    // second run sees the first run's fresh review here and stops.
    const freshness = await step.run("check-freshness", async () => {
      const admin = adminClient();
      const { data: newest, error } = await admin
        .from("exam_reviews")
        .select("id, topic_snapshot")
        .eq("user_id", userId)
        .eq("course_id", courseId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error !== null) {
        // A read failure is not proof of freshness; generate rather than skip.
        return { skip: false as const };
      }
      if (newest === null) return { skip: false as const };

      const current = new Map(loaded.topics.map((topic) => [topic.id, topic.revision]));
      const stale = isReviewStale(readSnapshot(newest.topic_snapshot), current);
      return { skip: !stale };
    });

    if (freshness.skip) {
      return { courseId, status: "skipped" as const, reason: "already-fresh" };
    }

    // ── Generate (the one Opus call), guarded ──────────────────────────────────
    const generated = await step.run("generate-review", async () => {
      let runtime: ReturnType<typeof createStudyAIRuntime>;
      try {
        runtime = createStudyAIRuntime({ userId });
      } catch (error) {
        if (error instanceof AINotConfiguredError) {
          return { kind: "deferred" as const, reason: "AI is not configured." };
        }
        throw error;
      }

      // Clamp check: exam-review is pinned to a deep-rank model. If AI_MAX_TIER has forced it
      // lower, do NOT silently generate a weaker review — defer, exactly as under budget.
      if (runtime.resolve("exam-review").rank !== REQUIRED_RANK) {
        return {
          kind: "deferred" as const,
          reason: "AI_MAX_TIER has clamped exam-review off its Opus tier.",
        };
      }

      // Budget check before spending: a deferred deep-rank job returns cleanly instead of
      // throwing a retryable AIPausedError that would burn the retry budget waiting for money.
      const decision = await runtime.guardCheck("exam-review", "background");
      if (!decision.allowed) {
        return { kind: "deferred" as const, reason: decision.reason };
      }

      try {
        const result = await runtime.generateStructured({
          job: "exam-review",
          prompt: examReviewPrompt,
          system: EXAM_REVIEW_SYSTEM,
          schema: examReviewSchema,
          kind: "background",
          vars: {
            courseTitle: loaded.courseTitle,
            examFormat: loaded.examFormat,
            topicIndex: renderTopicIndex(loaded.topics as readonly ReviewTopic[]),
          },
        });

        if (result.status === "dead-letter") {
          return { kind: "dead-letter" as const, message: result.message };
        }

        return {
          kind: "generated" as const,
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
        // TOCTOU: budget can cross between the guard check and the call. A pause is not a
        // failure — the work never ran — so surface it as deferred rather than retrying.
        if (error instanceof AIPausedError) {
          return { kind: "deferred" as const, reason: error.reason };
        }
        throw error;
      }
    });

    if (generated.kind === "deferred") {
      console.warn(`[generate-review] deferred for course ${courseId}: ${generated.reason}`);
      return { courseId, status: "deferred" as const, reason: generated.reason };
    }
    if (generated.kind === "dead-letter") {
      console.error(`[generate-review] dead-letter for course ${courseId}: ${generated.message}`);
      return { courseId, status: "dead-letter" as const };
    }

    // ── Persist ────────────────────────────────────────────────────────────────
    //
    // Its own step so a transport failure inserting the row does not re-run (and re-bill) the
    // Opus call above — the generate step is memoized, this one just writes.
    const inserted = await step.run("insert-review", async () => {
      const admin = adminClient();
      const snapshot = buildReviewSnapshot(loaded.topics);

      const { data, error } = await admin
        .from("exam_reviews")
        .insert({
          user_id: userId,
          course_id: courseId,
          // Written through the admin client (RLS-exempt): the user-facing UPDATE policy on
          // this table is `using (false)` — a review is an immutable artifact from the client.
          content: generated.content as unknown as Json,
          topic_snapshot: snapshot as unknown as Json,
          stale: false,
          prompt_id: generated.stamp.promptId,
          prompt_version: generated.stamp.promptVersion,
          provider: generated.stamp.provider,
          model: generated.stamp.model,
          input_hash: generated.stamp.inputHash,
        })
        .select("id")
        .single();

      if (error !== null) {
        throw new Error(`Could not insert exam review for course ${courseId}: ${error.message}`);
      }
      return { reviewId: data.id };
    });

    return {
      courseId,
      status: "generated" as const,
      reviewId: inserted.reviewId,
      topicCount: loaded.topics.length,
    };
  },
);

/** The `ExamReview` type, re-exported so the UI's row parser and this writer cannot drift. */
export type { ExamReview };
