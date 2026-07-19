/**
 * `mark-reviews-stale` — the staleness half of PLAN §9, and nothing more.
 *
 * > **Staleness, not auto-regen:** reviews are expensive (~$0.50–1.50 on Opus) and students
 * > regenerate near exams anyway. `exam_reviews.topic_snapshot` (topic id + revision pairs)
 * > is compared against current revisions; the UI shows "Based on materials through Lecture
 * > 9 — 2 topics changed since" with a *Regenerate* button.
 *
 * This function is the consumer of `course/topics.changed`, and it exists so that event is
 * genuinely wired rather than emitted into nothing.
 *
 * ## What it deliberately does NOT do
 *
 * It does not generate anything. Exam review **generation** is Wave 5 and out of scope for
 * item 5e; more importantly, auto-regenerating on every upload is the specific behaviour §9
 * rejects. A student who uploads six decks in an evening would otherwise trigger six Opus
 * calls at up to $1.50 each on a review nobody has opened — roughly a month's budget spent
 * on staleness that a single `Regenerate` click would have handled at the moment it
 * mattered. Setting a boolean is the whole job.
 *
 * ## Why the comparison is a real comparison
 *
 * The cheap version of this function sets `stale = true` on every review of the course
 * whenever anything changes. It is wrong in a way that degrades over a semester: a review
 * built after a topic changed is *not* stale, so a blanket update marks freshly-generated
 * reviews stale as soon as any unrelated topic moves, and the badge stops meaning anything.
 * So `topic_snapshot` is actually read and compared pair by pair, and a review is marked
 * stale only when a topic it was built from has genuinely moved past the revision it
 * recorded — or has disappeared.
 */

import type { SupabaseAdminClient } from "@study/db";
import { NonRetriableError } from "inngest";
import { inngest } from "@/inngest/client";
import { adminClient } from "@/inngest/documents";
import { courseTopicsChanged, courseTopicsChangedData } from "@/inngest/events";
import { deriveOwner } from "@/inngest/owner";

/**
 * One `(topicId, revision)` pair from `exam_reviews.topic_snapshot`.
 *
 * Parsed defensively rather than cast: the column is `jsonb` written by a generator that
 * does not exist yet, so every shape assumption here is a guess about Wave 5's output. A
 * snapshot this cannot read is treated as "cannot prove it is fresh" → stale, which is the
 * safe direction: the cost of a wrong `stale` is one avoidable click, and the cost of a
 * wrong `fresh` is a student revising from notes that no longer match their course.
 */
export function readSnapshot(value: unknown): { topicId: string; revision: number }[] | null {
  if (!Array.isArray(value)) return null;

  const pairs: { topicId: string; revision: number }[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as Record<string, unknown>;
    const topicId = record.topicId ?? record.topic_id;
    const revision = record.revision;
    if (typeof topicId !== "string" || typeof revision !== "number") return null;
    pairs.push({ topicId, revision });
  }
  return pairs;
}

/**
 * Whether a review built from `snapshot` is out of date given the course's current topics.
 *
 * Pure, so the rule is testable without a database — and it is a rule worth pinning, since
 * every branch is a different kind of "changed":
 * - a topic whose revision moved forward: the notes it was built from were edited;
 * - a topic that no longer exists: it was deleted or merged away;
 * - an unreadable snapshot: cannot be proven fresh, so treated as stale;
 * - a **new** topic the snapshot never knew about: **not** stale by itself. A review that
 *   covers everything it was asked to cover has not decayed because the course grew, and
 *   treating growth as decay would mark every review stale on the next upload forever.
 */
export function isReviewStale(
  snapshot: readonly { topicId: string; revision: number }[] | null,
  current: ReadonlyMap<string, number>,
): boolean {
  if (snapshot === null) return true;

  for (const pair of snapshot) {
    const revision = current.get(pair.topicId);
    if (revision === undefined) return true;
    if (revision > pair.revision) return true;
  }
  return false;
}

/** Current `(id → revision)` for every topic of a course. */
async function currentRevisions(
  admin: SupabaseAdminClient,
  userId: string,
  courseId: string,
): Promise<Map<string, number>> {
  const { data, error } = await admin
    .from("topics")
    .select("id, revision")
    .eq("user_id", userId)
    .eq("course_id", courseId);

  if (error !== null) {
    throw new Error(`Could not read topic revisions for course ${courseId}: ${error.message}`);
  }

  return new Map((data ?? []).map((row) => [row.id, row.revision]));
}

export const markReviewsStale = inngest.createFunction(
  {
    id: "mark-reviews-stale",
    // ⚠ v4: triggers live HERE, in the options object. The v3 three-argument form throws at
    // import time and takes down the whole `/api/inngest` route — see `process-document`.
    triggers: [courseTopicsChanged],
    retries: 3,
    // Serialized per course for the same reason the pipeline is: two runs both reading
    // revisions and writing `stale` would race, and the later write could re-mark a review
    // fresh that the earlier one correctly marked stale.
    concurrency: [{ key: "event.data.courseId", limit: 1 }],
  },
  async ({ event, step }) => {
    const parsed = courseTopicsChangedData.safeParse(event.data);
    if (!parsed.success) {
      throw new NonRetriableError(`Malformed course/topics.changed event: ${parsed.error.message}`);
    }
    const { courseId } = parsed.data;

    // Rule 8: the owner comes from the database row the event points at, never from the
    // payload. The event carries no `userId` precisely so it cannot claim one.
    const { userId } = await step.run("derive-owner", () =>
      deriveOwner(adminClient(), { table: "courses", id: courseId }, { job: "mark-reviews-stale" }),
    );

    return await step.run("mark-stale", async () => {
      const admin = adminClient();

      const { data: reviews, error } = await admin
        .from("exam_reviews")
        .select("id, topic_snapshot, stale")
        .eq("user_id", userId)
        .eq("course_id", courseId)
        .eq("stale", false);

      if (error !== null) {
        throw new Error(`Could not read exam reviews for course ${courseId}: ${error.message}`);
      }
      if (reviews === null || reviews.length === 0) {
        return { courseId, reviewsChecked: 0, markedStale: 0 };
      }

      const current = await currentRevisions(admin, userId, courseId);

      const staleIds = reviews
        .filter((review) => isReviewStale(readSnapshot(review.topic_snapshot), current))
        .map((review) => review.id);

      if (staleIds.length > 0) {
        // Written through the admin client, which is RLS-exempt — the user-facing UPDATE
        // policy on this table is `using (false)` (Gate 1 F3), because a review is an
        // immutable artifact from a client's point of view and `stale` is a derived flag
        // this job owns.
        const { error: updateError } = await admin
          .from("exam_reviews")
          .update({ stale: true })
          .eq("user_id", userId)
          .in("id", staleIds);

        if (updateError !== null) {
          throw new Error(`Could not mark reviews stale: ${updateError.message}`);
        }
      }

      return { courseId, reviewsChecked: reviews.length, markedStale: staleIds.length };
    });
  },
);
