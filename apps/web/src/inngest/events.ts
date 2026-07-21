import { eventType } from "inngest";
import { z } from "zod";

/**
 * Event definitions. One place, so a producer and a consumer cannot drift.
 *
 * An event payload is an external boundary in the strongest sense: it arrives
 * as JSON over the wire from Inngest, having been stored and replayed in
 * between, so it gets a Zod schema like every other boundary in this repo.
 * Inngest v4 takes any Standard Schema, which Zod 4 implements natively.
 *
 * ⚠ HANDING THE SCHEMA TO `eventType` DOES NOT VALIDATE ANYTHING ON THE WAY IN.
 * It is the TypeScript source of truth for `event.data`, and that is all it is
 * on the receive path: v4 does not run the schema over an incoming event before
 * invoking the handler. Measured, not assumed — an event carrying
 * `userId: "not-a-uuid"` reached the handler untouched and was caught by
 * Postgres (`invalid input syntax for type uuid`) rather than by Zod, which also
 * meant it surfaced as a generic retriable error and burned the retry budget.
 *
 * So the schemas are exported separately and every handler parses `event.data`
 * itself, which is what actually satisfies the repo's "Zod at every boundary"
 * rule. `eventType` keeps the types honest; `parse` keeps the data honest.
 *
 * ⚠⚠ AND NEITHER OF THEM KEEPS THE DATA *AUTHORISED*. READ THIS BEFORE ADDING AN
 * EVENT.
 *
 * `z.uuid()` proves a `userId` is a well-formed uuid. It proves nothing whatever
 * about whether the sender was entitled to name that user. Jobs run under
 * `createAdminSupabaseClient`, which bypasses RLS, so a handler that writes rows
 * owned by `event.data.userId` has handed tenant selection to whoever produced
 * the event — and the event is not a trusted input. It has been stored and
 * replayed by a third party; it may come from a replay, a leaked event key, a
 * buggy producer, or some future webhook that forwards something a user typed.
 * Validation makes a hostile payload well-formed. It does not make it true.
 *
 * **THE RULE: a handler re-derives `user_id` from the database row the event
 * points at. A `userId` in the payload is a HINT to cross-check, never an
 * authority.** `inngest/owner.ts` implements it — `deriveOwner()` — and a
 * disagreement between hint and database is treated as a security event: the run
 * fails loudly and writes nothing, because choosing a winner between two claimed
 * tenants is not a decision code gets to make quietly.
 *
 * So the useful shape for a new event is a **row id**, not an owner. Prefer
 * `{ documentId }` over `{ documentId, userId }`: the first cannot be lied to,
 * because the only tenant it can name is whichever one the database says owns
 * that row. Carry a `userId` as well only when it buys a genuine cross-check —
 * which is to say, when the producer knew the owner *independently* of the row
 * id, so that a mismatch means something.
 */

/**
 * Asks the background runner to prove it is alive end to end: publish → Inngest
 * → callback into `/api/inngest` → admin-client write and read → cleanup.
 *
 * `userId` is not decoration. Jobs run under `createAdminSupabaseClient`, which
 * bypasses RLS, so nothing downstream will infer an owner for them; the event
 * has to carry the user the work is done on behalf of, and every row written
 * has to stamp it. Making that mandatory in the *first* event definition is
 * cheaper than retrofitting it once the document pipeline (item 5) exists.
 *
 * ⚠ This event is the one honest exception to "send a row id, not an owner",
 * and the exception is worth understanding because it is narrow. A health check
 * has no subject: there is no document, no upload, no prior row it acts on — the
 * user *is* the whole payload. So the id it carries is the id of a `profiles`
 * row, and the handler still re-derives ownership from that row rather than
 * trusting the number it was handed (see `functions/health-check.ts`). The
 * derivation is nearly tautological here, and it is done anyway: the first job
 * in the codebase sets the pattern the document pipeline copies, and a pattern
 * with a "well, obviously not in this case" carve-out is not a pattern.
 */
export const healthCheckRequestedData = z.object({
  userId: z.uuid(),
});

export const healthCheckRequested = eventType("system/health-check.requested", {
  schema: healthCheckRequestedData,
});

/**
 * A `documents` row has been inserted and its bytes are in Storage. Run the
 * pipeline (PLAN "Document & Notes Pipeline" §3).
 *
 * ## Why this payload is `{ documentId, courseId }` and not `{ …, userId }`
 *
 * `documentId` is the subject, and per the ⚠⚠ rule above it is the only thing
 * that establishes a tenant: `process-document` calls `deriveOwner()` on it and
 * writes rows with the database's answer. A `userId` here would buy nothing —
 * the producer (the upload Server Action) knows the owner only *because* it just
 * wrote that row, so a cross-check would be comparing the database against
 * itself. The rule says carry a `userId` "only when it buys a genuine
 * cross-check", and this is the case where it does not, so it is absent.
 *
 * ## Why `courseId` is here anyway, and what that costs
 *
 * `courseId` is NOT for the handler. It is for Inngest: the function declares
 * `concurrency: [{ key: "event.data.courseId", limit: 1 }]`, and that expression
 * is evaluated by the platform against the raw event *before* any of our code
 * runs. A key that lived only in the database could not be used to serialize
 * runs, and per-course serialization is load-bearing — it is what lets the merge
 * step (Agent 4) use a plain incrementing revision counter instead of optimistic
 * locking.
 *
 * The cost is that `courseId` is an unverified claim at the moment it is used.
 * A forged one would place the run in the wrong concurrency lane, which is a
 * liveness problem rather than a data one. The handler closes the data half by
 * checking `courseId` against the document row and refusing when they disagree —
 * see `DocumentCourseMismatchError`. The lane assignment itself cannot be
 * verified before the fact, and that is an accepted, bounded limitation of using
 * a payload field as a concurrency key at all.
 */
export const documentUploadedData = z.object({
  documentId: z.uuid(),
  courseId: z.uuid(),
});

export const documentUploaded = eventType("document/uploaded", {
  schema: documentUploadedData,
});

/**
 * A document reached a terminal state (PLAN §8). Emitted once, at the end of every run.
 *
 * ## Why this exists even though `documents.status` already says so
 *
 * The status column is *state*; this is an *event*. Anything that needs to act at the
 * moment a document finishes — as opposed to needing to know whether it has — cannot get
 * that from a column without polling it. The status UI is a Realtime subscriber and does
 * not need this; a future consumer that wants to act once (a digest, a notification, a
 * downstream regeneration) does.
 *
 * ⚠ **The name is deliberately `document/ready` even though it also fires for `partial` and
 * `failed`.** Agent 2 chose the name, nothing consumed it, and renaming it later would be a
 * silent breakage for any consumer subscribed by string. The `status` field carries the
 * actual outcome; the event name means "this document is done being processed".
 *
 * Carries `courseId` for the same reason `document/uploaded` does — so a consumer can
 * concurrency-key on it — and no `userId`, per rule 8: a handler re-derives the owner from
 * `documentId`.
 */
export const documentReadyData = z.object({
  documentId: z.uuid(),
  courseId: z.uuid(),
  status: z.enum(["ready", "partial", "failed"]),
});

export const documentReady = eventType("document/ready", {
  schema: documentReadyData,
});

/**
 * A course's topic set changed (PLAN §9's staleness rule).
 *
 * > `exam_reviews.topic_snapshot` (topic id + revision pairs) is compared against current
 * > revisions; the UI shows "Based on materials through Lecture 9 — 2 topics changed since"
 * > with a *Regenerate* button.
 *
 * This is the trigger for **marking reviews stale**, and emphatically not for regenerating
 * them. §9 is explicit that reviews are expensive (~$0.50–1.50 on Opus) and that students
 * regenerate near exams anyway, so auto-regeneration on every upload would be the single
 * most effective way to spend a monthly budget on documents nobody has opened yet. Exam
 * review *generation* is Wave 5; this event and its staleness handler are the whole of §9
 * that item 5e owns.
 *
 * `topicIds` is carried because it is genuinely useful to a consumer and cannot be
 * reconstructed after the fact — "which topics changed" is not derivable from the course row
 * a moment later. It is a hint about *what* changed, never about *who* owns it: the handler
 * still re-derives the owner from `courseId`.
 */
export const courseTopicsChangedData = z.object({
  courseId: z.uuid(),
  documentId: z.uuid().nullable(),
  topicIds: z.array(z.uuid()),
});

export const courseTopicsChanged = eventType("course/topics.changed", {
  schema: courseTopicsChangedData,
});

/**
 * A student asked for this course's exam review to be (re)generated (PLAN §9's *Regenerate*
 * button). The trigger for the one on-demand Opus call §9 describes.
 *
 * ## Why the payload is `{ courseId }` and nothing else
 *
 * Per the ⚠⚠ rule above, the owner is NOT in the payload: `generate-review` calls
 * `deriveOwner()` on `courseId` and writes the `exam_reviews` row with the database's answer,
 * exactly as `mark-reviews-stale` does with the same id. A `userId` here would buy no
 * cross-check — the producer (the Regenerate Server Action) knows the owner only because it
 * just read the course row under RLS, so comparing it back would be comparing the database
 * against itself — so it is absent, and the event cannot be made to name a tenant it does not
 * own.
 *
 * `courseId` doubles as the concurrency key: `generate-review` declares
 * `concurrency: [{ key: "event.data.courseId", limit: 1 }]`, which is what makes a
 * double-click or a click-while-in-flight serialize into one run behind another rather than
 * two parallel Opus calls — and the second run then sees the fresh review the first produced
 * and skips, so the ~$0.50–1.50 call is not billed twice.
 */
export const courseReviewRequestedData = z.object({
  courseId: z.uuid(),
});

export const courseReviewRequested = eventType("course/review.requested", {
  schema: courseReviewRequestedData,
});
