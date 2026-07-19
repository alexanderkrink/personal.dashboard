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
 * ## Dev mode
 *
 * `isDev` is deliberately NOT set. Inngest infers it from `NODE_ENV`, so
 * `next dev` talks to `inngest-cli dev` and a Vercel deployment talks to
 * Inngest Cloud with signature verification on. Hardcoding `isDev: true` here
 * would disable signature verification, which is the entire authentication on
 * `/api/inngest` — see the carve-out comment in `lib/supabase/proxy-session.ts`.
 */
export const inngest = new Inngest({
  id: "study-dashboard",
  eventKey: env.INNGEST_EVENT_KEY,
});
