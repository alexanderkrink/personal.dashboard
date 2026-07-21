/**
 * `generate-review` — the on-demand half of PLAN §9: one Opus call per course that turns the
 * course's topic pages and exam weights into an `exam_reviews` row.
 *
 * The staleness half already exists (`mark-reviews-stale`); this is its counterpart, the
 * consumer of `course/review.requested`. §9 is explicit that generation is **on demand, not
 * automatic** — reviews cost ~$0.50–1.50 on Opus and a student regenerates near an exam — so
 * nothing enqueues this except the Regenerate button's Server Action.
 *
 * ## An explicit Regenerate ALWAYS generates
 *
 * There is deliberately no content-freshness skip here. Staleness (`isReviewStale`) is a
 * revision-only "growth is not decay" predicate — right for the *badge* (a newly-added topic
 * must not flip every review stale forever) but wrong as a generation gate: a student who
 * uploads a new lecture and hits Regenerate wants exactly that new material folded in, and no
 * covered topic's revision moved, so a freshness gate would silently skip the one run they
 * asked for. The user already confirmed the cost; the function's job is to run it.
 *
 * ## The two money guards
 *
 *  1. **No double bill on a double-click.** Per-course `concurrency: 1` serializes runs, and
 *     `idempotency` on the client-supplied `requestId` makes two sends of the *same* request
 *     collapse to one run at the platform level — so a double-click (or a click that races the
 *     button's own in-flight disable) cannot enqueue a second Opus run, while a genuinely new
 *     request (fresh `requestId`) still runs.
 *  2. **No double bill on an Inngest retry.** The billed call lives in its own memoized step,
 *     and `generateExamReviewContent` converts any post-spend failure into a
 *     `NonRetriableError` — see the invariant documented there. A retry replays the memoized
 *     result rather than re-calling Opus.
 *
 * Rule 8 (`events.ts`): the owner is derived from the `courses` row, never from the payload —
 * the event carries only `courseId` (+ the idempotency `requestId`).
 */

import { type ExamReview, storedTopicPageSchema } from "@study/ai";
import type { Json } from "@study/db";
import { NonRetriableError } from "inngest";
import { inngest } from "@/inngest/client";
import { adminClient } from "@/inngest/documents";
import { courseReviewRequested, courseReviewRequestedData } from "@/inngest/events";
import {
  buildReviewSnapshot,
  generateExamReviewContent,
  renderExamFormat,
} from "@/inngest/exam-review";
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

export const generateReview = inngest.createFunction(
  {
    id: "generate-review",
    // ⚠ v4: triggers live in the options object, like every other function here.
    triggers: [courseReviewRequested],
    // A user-initiated regeneration: a transient DB blip should retry, but not forever.
    retries: 2,
    // Serialized per course — half of the double-bill guard.
    concurrency: [{ key: "event.data.courseId", limit: 1 }],
    // The other half: two sends of the SAME request (a double-click, or a click that races the
    // button's in-flight disable) dedupe to one run at the platform level. A genuinely new
    // Regenerate carries a fresh requestId and still runs.
    idempotency: "event.data.requestId",
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

    // ── Generate (the one Opus call), guarded and memoized ─────────────────────
    //
    // Its own step so an Inngest retry of a LATER step (the insert) replays this from memo
    // rather than re-billing Opus. `generateExamReviewContent` owns the clamp/budget gate and
    // the retry double-bill guard; a post-spend failure surfaces as NonRetriableError and stops
    // the run here rather than re-running the paid call.
    const generated = await step.run("generate", async () => {
      let runtime: ReturnType<typeof createStudyAIRuntime>;
      try {
        runtime = createStudyAIRuntime({ userId });
      } catch (error) {
        if (error instanceof AINotConfiguredError) {
          return {
            kind: "deferred" as const,
            cause: "unconfigured" as const,
            detail: error.message,
          };
        }
        throw error;
      }
      return generateExamReviewContent({
        runtime,
        courseTitle: loaded.courseTitle,
        examFormat: loaded.examFormat,
        topics: loaded.topics,
      });
    });

    if (generated.kind === "deferred") {
      console.warn(
        `[generate-review] deferred for course ${courseId} (${generated.cause}): ${generated.detail}`,
      );
      return { courseId, status: "deferred" as const, cause: generated.cause };
    }
    if (generated.kind === "dead-letter") {
      console.error(`[generate-review] dead-letter for course ${courseId}: ${generated.message}`);
      return { courseId, status: "dead-letter" as const };
    }

    // ── Persist ────────────────────────────────────────────────────────────────
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
