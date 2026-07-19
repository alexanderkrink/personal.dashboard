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
