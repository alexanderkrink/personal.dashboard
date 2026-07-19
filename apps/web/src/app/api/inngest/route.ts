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

export const runtime = "nodejs";

/** Never cached — a cached response here would silently stop running jobs. */
export const dynamic = "force-dynamic";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [healthCheck],
});
