/**
 * The daily calendar-sync safety net (§3.1 step 2).
 *
 * Runs at **04:30 UTC** (`vercel.json`), so deadlines added upstream while
 * Alexander isn't visiting still land before he looks. On-demand staleness
 * (§3.1 step 1) covers everything else.
 *
 * ## 🔒 Why this is a route handler and not a page
 *
 * This is the **only** route in the app reachable with no session and no
 * access-code cookie, and the shape is load-bearing rather than incidental.
 *
 * In the App Router a page is a Server Action host: Next resolves an incoming
 * `$ACTION_ID_…` POST against the actions bundled for the requested page, and
 * every action in the app is bundled into every page that imports one. Wave 1
 * exempted a *page* from the gate and thereby made `signUp`, `signIn` and
 * `resetPassword` callable with no access code at all.
 *
 * A route handler has no action surface. This one exports **GET only** — no
 * POST, no PUT — so there is nothing for an action id to resolve against, and
 * `UNGATED_PATHS` carries `/api/cron` rather than any page prefix.
 *
 * ## Authentication
 *
 * `Authorization: Bearer <CRON_SECRET>`, compared through `secretEqual`, which
 * hashes both operands to fixed-width digests before a constant-time compare.
 * That removes both the timing leak and the length leak — a naive `===` on the
 * raw strings tells an attacker how many leading characters were right, and
 * bailing out on a length mismatch tells them how long the real secret is.
 *
 * `node:crypto`'s `timingSafeEqual` is deliberately not used: this file shares
 * its comparison primitive with the proxy, which Next runs on the Edge runtime
 * where `node:crypto` does not exist.
 *
 * ## What it does NOT do
 *
 * It never reads a feed id from the request. The URL carries no parameters at
 * all — the handler asks the database for every active feed and syncs those.
 * A cron endpoint that accepted an id would be a confused deputy: it runs under
 * `createAdminSupabaseClient`, which bypasses RLS, so an id from the wire would
 * let anyone holding the secret drive a sync against any user's feed.
 */

import { createAdminSupabaseClient } from "@study/db";
import { NextResponse } from "next/server";
import { env } from "@/env";
import { secretEqual } from "@/lib/auth/access-code";
import { createSupabaseCalendarStore } from "@/server/calendar/store-supabase";
import { syncFeed } from "@/server/calendar/sync";

/**
 * Node runtime, not Edge: the sync engine downloads and parses a ~380-event ICS
 * file, which wants the larger memory and CPU-time budget.
 */
export const runtime = "nodejs";

/** Never cached — a cron hit that returned a cached body would sync nothing. */
export const dynamic = "force-dynamic";

/** Reads the bearer token, tolerating the header being absent or malformed. */
function bearerToken(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

export async function GET(request: Request): Promise<NextResponse> {
  const token = bearerToken(request.headers.get("authorization"));

  // The comparison runs even when the header is missing, against a value that
  // cannot match, so an absent header and a wrong one take the same time and
  // return the same body. `WWW-Authenticate` is what makes the 401 a correct
  // one rather than merely a refusal.
  const authorized = await secretEqual(token ?? "", env.CRON_SECRET);
  if (!authorized) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
    );
  }

  const supabase = createAdminSupabaseClient({
    url: env.NEXT_PUBLIC_SUPABASE_URL,
    secretKey: env.SUPABASE_SECRET_KEY,
  });

  // `id` only. Nothing else about a feed is needed to sync it, and `config`
  // holds the capability token — a column not selected is a column that cannot
  // be logged by accident.
  const { data: feeds, error } = await supabase
    .from("calendar_feeds")
    .select("id")
    .eq("active", true);

  if (error) {
    return NextResponse.json({ error: "Could not list feeds." }, { status: 500 });
  }

  const results = { ok: 0, unchanged: 0, skipped: 0, failed: 0 };

  // Sequential on purpose. Feeds are few, and a serverless function that opens
  // N concurrent ICS downloads is one that gets rate-limited by the university
  // rather than one that finishes sooner.
  for (const feed of feeds ?? []) {
    const outcome = await syncFeed(createSupabaseCalendarStore(supabase), feed.id);
    if (outcome.status === "ok") results.ok += 1;
    else if (outcome.status === "unchanged") results.unchanged += 1;
    else if (outcome.status === "skipped") results.skipped += 1;
    else results.failed += 1;
  }

  // Counts only. The per-feed error strings are already redacted by the engine,
  // but they are also of no use to a cron runner, and the narrowest response
  // that answers "did it run" is the right one for an unauthenticated-by-cookie
  // endpoint.
  return NextResponse.json({ feeds: feeds?.length ?? 0, ...results });
}
