import { createAdminSupabaseClient } from "@study/db";
import { NonRetriableError } from "inngest";
import { env } from "@/env";
import { inngest } from "@/inngest/client";
import { healthCheckRequested, healthCheckRequestedData } from "@/inngest/events";

/**
 * The round-trip proof for the background job runner (M1 item 2).
 *
 * ## What it is for
 *
 * `/api/inngest` is the one endpoint in this app that is exempt from the
 * access-code gate *and* accepts POST — a carve-out justified only by the
 * signing key actually working (see `lib/supabase/proxy-session.ts`). This
 * function is how that claim stays testable: it does no product work, but it
 * exercises every link that Wave 4's document pipeline will depend on. A
 * `console.log` would have proved that Inngest can reach a route handler and
 * nothing else.
 *
 * Specifically, a successful run proves:
 *   1. an event published to Inngest is accepted and matched to a trigger;
 *   2. Inngest calls back into *this deployment* and the signature verifies;
 *   3. `createAdminSupabaseClient` can reach the database from job context;
 *   4. steps checkpoint and resume across the multiple HTTP round trips
 *      Inngest makes — each `step.run` below is a separate invocation of the
 *      route handler, which is exactly where a broken gate exemption would
 *      show up.
 *
 * ## Why it cleans up after itself
 *
 * The heartbeat row is written, read back, and deleted inside the same run, so
 * the table's steady state is empty. A health check that accumulated rows would
 * become a thing to garbage-collect, and this one is meant to be safe to run on
 * a schedule or by hand from the dashboard as often as anyone likes.
 *
 * ## Why RLS bypass is correct here
 *
 * There is no request user in job context to derive a session from, so the
 * admin client is the only option — per repo conventions and PLAN.md §3. The
 * discipline that replaces RLS is that the owner arrives *in the event* and is
 * stamped on the row; the function never invents one and never writes a row
 * without it.
 */
export const healthCheck = inngest.createFunction(
  {
    id: "health-check",
    // NOTE: two arguments, not three. inngest v4 moved triggers INTO the options
    // object; the `createFunction(opts, trigger, handler)` form in PLAN.md §3's
    // pipeline sketch is v3 and throws at import time on this version.
    triggers: [healthCheckRequested],
    // One retry. A transient database blip should not report the runner as
    // broken, but a health check that retried many times would mask exactly the
    // sustained failure it exists to surface.
    retries: 1,
  },
  async ({ event, step, runId }) => {
    // Parse rather than destructure. `eventType`'s schema types `event.data` but
    // does not check it on the way in (see `inngest/events.ts`), and this value
    // is about to be written as a row owner through a client that bypasses RLS —
    // the last place to want an unvalidated string. NonRetriable because a
    // malformed payload is malformed on every attempt; without this, a bad
    // `userId` reached Postgres and came back as a generic retriable error.
    const parsed = healthCheckRequestedData.safeParse(event.data);
    if (!parsed.success) {
      throw new NonRetriableError(`Malformed health-check event: ${parsed.error.message}`);
    }
    const { userId } = parsed.data;

    // Each step gets its own client rather than one hoisted out of the handler.
    // Steps are separate HTTP invocations that may land on different serverless
    // instances, so a shared client would be rebuilt anyway — and building it
    // inside the step keeps the secret read next to its single use.
    const admin = () =>
      createAdminSupabaseClient({
        url: env.NEXT_PUBLIC_SUPABASE_URL,
        secretKey: env.SUPABASE_SECRET_KEY,
      });

    const heartbeatId = await step.run("write-heartbeat", async () => {
      const { data, error } = await admin()
        .from("job_heartbeats")
        .insert({ user_id: userId, job: "health-check", run_id: runId })
        .select("id")
        .single();

      if (error) {
        // A bad `userId` violates the FK to auth.users, and no number of
        // retries will make a non-existent user exist. Failing fast here keeps
        // a malformed event from burning the retry budget and reports the real
        // cause in the dashboard instead of a generic timeout.
        if (error.code === "23503") {
          throw new NonRetriableError(`No such user: ${userId}`);
        }
        throw new Error(`Heartbeat insert failed: ${error.message}`);
      }

      return data.id;
    });

    // Read back through a *fresh* client, not the insert's return value. The
    // point is to prove the row is durable and visible to a later invocation,
    // which is what item 5's steps will actually rely on; trusting the value
    // the insert echoed back would prove only that the insert call returned.
    await step.run("read-back-heartbeat", async () => {
      const { data, error } = await admin()
        .from("job_heartbeats")
        .select("id, user_id, job")
        .eq("id", heartbeatId)
        .single();

      if (error) {
        throw new Error(`Heartbeat read-back failed: ${error.message}`);
      }
      if (data.user_id !== userId) {
        throw new NonRetriableError(
          "Heartbeat read back with the wrong owner — job rows must carry the requesting user.",
        );
      }
    });

    // Only reached when the read-back succeeded — a failed run deliberately
    // leaves its row behind. That is the more useful failure mode: a stuck
    // heartbeat in the table names the run that could not complete, whereas an
    // `onFailure` cleanup would erase the only evidence. Steady state is still
    // empty, because a healthy run always reaches this step.
    await step.run("delete-heartbeat", async () => {
      const { error } = await admin().from("job_heartbeats").delete().eq("id", heartbeatId);
      if (error) {
        throw new Error(`Heartbeat cleanup failed: ${error.message}`);
      }
    });

    return { ok: true, heartbeatId, userId, runId };
  },
);
