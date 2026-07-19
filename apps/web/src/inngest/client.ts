import { Inngest } from "inngest";
import { env } from "@/env";

/**
 * The Inngest client (PLAN.md §3 — "Background job runner").
 *
 * Functions live in `src/inngest/functions/` and are served from
 * `app/api/inngest/route.ts`. Inngest runs them by calling back into our own
 * Vercel deployment, so there is no second deploy target and no separate
 * runtime — a job is just a POST to a route handler in this app.
 *
 * ## Keys
 *
 * `eventKey` points outward: it authenticates us to Inngest when we publish an
 * event. It is optional in `env.ts` (see the comment there), and passing
 * `undefined` is the documented way to say "not configured" — the client then
 * falls back to the local dev server, which mints its own key. The inbound
 * direction is authenticated by `INNGEST_SIGNING_KEY`, which the serve handler
 * reads; the two are not interchangeable.
 *
 * ## Dev mode — read this before debugging a local 401
 *
 * ⚠ v4 does NOT infer dev mode from `NODE_ENV`. `Inngest.mode` checks the
 * `isDev` option, then `INNGEST_DEV`, then whether `INNGEST_DEV` holds a URL,
 * and **defaults to `"cloud"`** — so `next dev` with nothing set runs the
 * production path and answers `inngest-cli dev` with 401, because the CLI does
 * not sign its requests. Local development needs `INNGEST_DEV=1` in
 * `.env.local`; see `.env.example`.
 *
 * `isDev` is deliberately left unset here rather than computed. Hardcoding
 * `isDev: true` would disable signature verification, which is the entire
 * authentication on `/api/inngest` (see the carve-out comment in
 * `lib/supabase/proxy-session.ts`), and deriving it from `NODE_ENV` ourselves
 * would reintroduce the exact inference v4 dropped — one mis-set `NODE_ENV` in
 * a preview deploy and the endpoint stops checking signatures. Defaulting to
 * cloud means the failure mode of a misconfiguration is a 401, not an open door.
 */
export const inngest = new Inngest({
  id: "study-dashboard",
  eventKey: env.INNGEST_EVENT_KEY,
});

/**
 * Dev mode must never survive into a production deployment.
 *
 * Defaulting to cloud (above) makes dev mode something you have to opt into, but
 * it does not make opting in *loud*, and the cost of a silent opt-in here is not
 * a degraded feature — it is a full authentication bypass. In dev mode `serve()`
 * skips signature verification, and `/api/inngest` has no other authentication:
 * it is exempt from the access-code gate and it accepts POST. An unsigned POST
 * from anyone on the internet then runs function code, which reaches the database
 * through `createAdminSupabaseClient` and therefore bypasses RLS. That is not
 * hypothetical — it was reproduced against a production build with `INNGEST_DEV=1`
 * set: an unauthenticated request wrote a `job_heartbeats` row for a user id it
 * chose itself.
 *
 * So the guard is a throw, not a warning. A route that refuses to load is a
 * loud, contained outage; a route that loads without checking signatures is a
 * quiet, uncontained one.
 *
 * Scoped to `VERCEL_ENV === "production"` deliberately: that is set only in a
 * real production deployment on Vercel, so this cannot fire during a local
 * `pnpm build` or in CI, where `INNGEST_DEV=1` is legitimate and expected.
 * Preview deploys are left alone for the same reason they are elsewhere — they
 * are not the environment holding real data.
 */
if (process.env.VERCEL_ENV === "production" && inngest.mode !== "cloud") {
  throw new Error(
    "Inngest is in dev mode in a production deployment, which disables signature " +
      "verification on /api/inngest — the only authentication that endpoint has. " +
      "Unset INNGEST_DEV in the production environment.",
  );
}
