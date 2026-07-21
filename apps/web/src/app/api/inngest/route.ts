/**
 * The Inngest endpoint (PLAN.md §3). Inngest reaches our functions through here.
 *
 * ## 🔒 Why this route exports POST and PUT, and why that is allowed
 *
 * This is the second route in the app listed in `UNGATED_PATHS`, and unlike
 * `/api/cron` it is **not** GET-only:
 *   - **POST** — Inngest invokes a function, once per step.
 *   - **PUT**  — Inngest syncs the app: it asks this endpoint to introspect
 *                itself and register the functions it serves.
 *   - **GET**  — introspection, used by the dev server and the sync UI.
 *
 * The standing rule in `proxy-session.ts` is that a gate exemption must be a
 * route handler and never a page, because a page is a Server Action host and
 * exempting one exempts `signUp`/`signIn`/`resetPassword` along with it. This
 * file satisfies the load-bearing half of that rule: it is a route handler, so
 * no actions are bundled into it and there is nothing for an incoming
 * `$ACTION_ID_…` POST to resolve against. The GET-only half is relaxed here, and
 * `INNGEST_SIGNING_KEY` is what pays for it — every invocation is signed by
 * Inngest and verified by `serve()` before a single line of function code runs.
 * That is why the key is REQUIRED in `env.ts` rather than optional, and why
 * `route.test.ts` asserts an *unsigned* POST is refused rather than merely
 * asserting the route exists.
 *
 * ## Runtime
 *
 * Node, not Edge: jobs use `createAdminSupabaseClient` and (from item 5 on) the
 * document pipeline, both of which want the larger memory and CPU-time budget.
 */

import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { healthCheck } from "@/inngest/functions/health-check";
import { markReviewsStale } from "@/inngest/functions/mark-reviews-stale";
import { processDocument } from "@/inngest/functions/process-document";

export const runtime = "nodejs";

/** Never cached — a cached response here would silently stop running jobs. */
export const dynamic = "force-dynamic";

/**
 * ## ⚠ Wave 7 §3 stopgap: an explicit ceiling on how long one step may run.
 *
 * The §3 data loss began with a merge step that ran past ~300s and was killed with no
 * `maxDuration` configured anywhere, so the platform's default cut it off mid-write. This
 * raises the ceiling to the Vercel Pro / Fluid maximum (800s) for every Inngest step
 * invocation served here — a belt, not the fix. The real fix is that the merge is now
 * resumable (`runRouteAndMergeSteps`): each target is its own memoized step, so even a step
 * that does hit this ceiling resumes at the target it died on instead of re-routing.
 *
 * This is a Next.js route-segment config, the correct Next 16 mechanism for a route handler;
 * Vercel reads it to size the function's execution limit.
 */
export const maxDuration = 800;

export const { GET, POST, PUT } = serve({
  client: inngest,
  // ⚠ A function not in this array is a function that does not run, however
  // correctly it is written and however many events name it. `markReviewsStale`
  // is the consumer of `course/topics.changed`; without it here the pipeline
  // would emit that event into nothing, which is exactly the half-wired state
  // the event was added to avoid.
  //
  // ⚠⚠ EDITING THIS ARRAY IS NOT ENOUGH. Inngest only learns what this app serves
  // when something calls `PUT /api/inngest`, and NOTHING here does that on deploy:
  // the Inngest app shows `Vercel project: -`, so the Vercel↔Inngest integration is
  // not installed and a deploy does not resync. Until it is, run `pnpm inngest:sync`
  // after deploying any change to this list, then `pnpm inngest:verify` — the sync
  // proves the endpoint answered; the verify proves what the platform recorded,
  // by diffing its registry against the functions derived from THIS array.
  //
  // The cost of forgetting is silent and total. Wave 4 shipped `processDocument`
  // against a registry eight hours older than the function: `Events received: 1`,
  // `Executions ran: 0`, a document parked at `queued`, and no error anywhere —
  // because as far as Inngest knew, the function did not exist.
  functions: [healthCheck, processDocument, markReviewsStale],
});
