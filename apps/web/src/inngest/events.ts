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
