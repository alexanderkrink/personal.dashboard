import { createAdminSupabaseClient } from "@study/db";
import { after } from "next/server";
import { env } from "@/env";
import { selectStaleFeeds } from "./staleness";
import { createSupabaseCalendarStore } from "./store-supabase";
import { syncFeed } from "./sync";

/**
 * Stale-while-revalidate for the calendar (§3.1 step 1).
 *
 * Called from the RSCs that render calendar data. It **returns immediately** —
 * the page renders from whatever is already in the database — and hands the
 * actual sync to Next 16's `after()`, which runs it once the response has been
 * flushed. Awaiting the sync inline would make the dashboard's first paint wait
 * on a university HTTP endpoint, which is exactly the latency §3.1 is designed
 * to keep off the render path.
 *
 * ## Why this takes feed rows rather than fetching them
 *
 * The caller has already queried `calendar_feeds` to render the sync-status
 * strip. Passing those rows in keeps this to zero extra round trips on the
 * render path, and keeps the *decision* (which feeds are stale) in the pure,
 * tested `selectStaleFeeds`.
 *
 * ## 🔒 The admin client, and why it is legitimate here
 *
 * `syncFeed` runs under `createAdminSupabaseClient`, which bypasses RLS. That is
 * correct for a background job and a confused-deputy hole if the feed id came
 * from the wire. It does not: the ids passed here were read moments earlier
 * through the *user's* RLS-scoped client by the calling RSC, so the only feeds
 * reachable are ones RLS already agreed belong to them. The admin client also
 * never appears until `after()` has fired, i.e. after the response is sent — it
 * is never in the request path acting for a user.
 */
export function refreshStaleFeeds(
  feeds: readonly { id: string; active: boolean; last_synced_at: string | null }[],
  now: Date = new Date(),
): void {
  const stale = selectStaleFeeds(feeds, now);
  if (stale.length === 0) return;

  after(async () => {
    const store = createSupabaseCalendarStore(
      createAdminSupabaseClient({
        url: env.NEXT_PUBLIC_SUPABASE_URL,
        secretKey: env.SUPABASE_SECRET_KEY,
      }),
    );

    for (const feedId of stale) {
      // A background refresh must never surface as a request failure: the
      // response has already been sent. A feed that is down gets its error
      // recorded on its own row by `syncFeed`, which is where the sync-status
      // strip reads it from on the next render.
      try {
        await syncFeed(store, feedId);
      } catch {
        // Deliberately swallowed — see above. `syncFeed` has already written
        // the redacted reason to `calendar_feeds.last_sync_error`.
      }
    }
  });
}
