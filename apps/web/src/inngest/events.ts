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
 */
export const healthCheckRequestedData = z.object({
  userId: z.uuid(),
});

export const healthCheckRequested = eventType("system/health-check.requested", {
  schema: healthCheckRequestedData,
});
