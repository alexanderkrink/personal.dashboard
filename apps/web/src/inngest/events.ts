import { eventType } from "inngest";
import { z } from "zod";

/**
 * Event definitions. One place, so a producer and a consumer cannot drift.
 *
 * An event payload is an external boundary in the strongest sense: it arrives
 * as JSON over the wire from Inngest, having been stored and replayed in
 * between, so it gets a Zod schema like every other boundary in this repo.
 * Inngest v4 takes any Standard Schema, which Zod 4 implements natively — the
 * schema is both the TypeScript source of truth for `event.data` and a runtime
 * check on `.create()`.
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
export const healthCheckRequested = eventType("system/health-check.requested", {
  schema: z.object({
    userId: z.uuid(),
  }),
});
