import { createServerSupabaseClient } from "@study/db";
import { type NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import { GATE_COOKIE_NAME, isGateCookieValid } from "@/lib/auth/access-code";

/**
 * Reachable with NO session and NO gate cookie.
 *
 * These are the email-link landing routes: someone clicking a confirmation link
 * from their inbox on a fresh device has no gate cookie yet, and blocking them
 * would break sign-up verification and password reset. Each authenticates
 * itself with a single-use token, so none of them needs the gate. `/api/hooks`
 * is the Supabase Send Email webhook, authenticated by its own signature.
 *
 * SECURITY: every entry here MUST be a route handler that exports only GET —
 * never a page. In the App Router a page is a Server Action host: Next resolves
 * an incoming `$ACTION_ID_…` POST against the actions bundled for the requested
 * page, and EVERY action in the app is bundled into every page that imports one
 * (see .next/server/server-reference-manifest.json). Exempting a page from the
 * gate therefore exempts `signUp`, `signIn`, `sendMagicLink` and
 * `requestPasswordReset` along with it, which is exactly the bypass this list
 * used to have when it read `"/auth"` and so covered the
 * `/auth/update-password` PAGE. Route handlers have no action surface and are
 * safe; pages are not.
 *
 * `/auth/update-password` is deliberately NOT here. `/auth/confirm` verifies
 * the recovery token and mints a session BEFORE redirecting there, so the
 * legitimate reset flow always arrives carrying that session and is let through
 * by the `hasSession` branch below — the page then guards itself.
 *
 * `/api/cron` is the Vercel Cron entry point (§3.1). It satisfies the rule
 * above: `calendar-sync/route.ts` exports GET and nothing else, and
 * authenticates every request against `CRON_SECRET` with a constant-time
 * comparison before it touches the database.
 *
 * `/api/inngest` is a DOCUMENTED EXCEPTION to the GET-only half of that rule,
 * and the only one. Inngest invokes functions with POST and syncs the app with
 * PUT, so a GET-only exemption would not work at all. It is sound because the
 * two halves of the rule do different jobs: "route handler, not page" is what
 * keeps Server Actions out of the exemption, and that half holds — route
 * handlers have no action surface, so no `$ACTION_ID_…` POST resolves against
 * this path no matter which methods it exports. "GET-only" was the belt to that
 * braces, and what replaces it here is `INNGEST_SIGNING_KEY`: `serve()` verifies
 * Inngest's signature on every request before running any function code, and
 * `env.ts` makes the key REQUIRED so the build fails rather than shipping the
 * endpoint unauthenticated. `app/api/inngest/route.test.ts` asserts an unsigned
 * POST is refused — that test is the justification for this entry, so if it is
 * ever deleted, this exemption must go with it.
 *
 * This is a carve-out, not a precedent. Adding a non-GET route here again needs
 * its own authentication story and its own test proving that story works.
 *
 * Matching is by exact segment (see `startsWithAny`), so this entry covers
 * `/api/inngest` and `/api/inngest/...` and nothing else — a sibling path like
 * `/api/inngest-admin` stays gated.
 */
export const UNGATED_PATHS = [
  "/auth/confirm",
  "/auth/callback",
  "/api/hooks",
  "/api/cron",
  "/api/inngest",
];

/** Reachable with no session, but ONLY once the access-code gate is cleared. */
const GATED_AUTH_PATHS = ["/login", "/signup", "/forgot-password"];

/** The access-code screen itself. Served at `/` by rewrite, never linked to. */
const GATE_PATH = "/gate";

/**
 * Prefix match on whole path SEGMENTS, never on characters.
 *
 * The `${prefix}/` half is what makes this safe: a plain
 * `pathname.startsWith(prefix)` would let `/api/inngest-admin` and
 * `/api/inngestX` inherit `/api/inngest`'s gate exemption, turning one
 * deliberate carve-out into a namespace of accidental ones. Exported so
 * `proxy-session.test.ts` can pin that behaviour directly, since the widening
 * would be invisible in any test that only checked the paths we do exempt.
 */
export function startsWithAny(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * Returns a redirect/rewrite that carries over any cookies Supabase set while
 * refreshing the session. Dropping them would throw away a freshly rotated
 * refresh token and log the user out on the next request.
 */
function divert(response: NextResponse, carrying: NextResponse): NextResponse {
  for (const cookie of carrying.cookies.getAll()) {
    response.cookies.set(cookie);
  }
  return response;
}

/**
 * Refreshes the Supabase session on every request, then applies the access-code
 * gate and the signed-in/signed-out routing rules. Called from src/proxy.ts.
 *
 * The gate is enforced HERE, at the proxy layer, and not merely hidden in the
 * UI: `/login` and `/signup` are unreachable by direct URL without a valid gate
 * cookie, because this function never lets the request reach them.
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerSupabaseClient(
    {
      url: env.NEXT_PUBLIC_SUPABASE_URL,
      publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    },
    {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        supabaseResponse = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, options);
        }
      },
    },
  );

  // IMPORTANT: do not run code between client creation and getClaims() —
  // it can cause session refresh races and random logouts.
  const { data } = await supabase.auth.getClaims();

  // ---------------------------------------------------------------------
  // Everything below runs AFTER getClaims() has resolved, so none of it sits
  // inside the window the comment above protects. The access-code gate reads
  // cookies off the request and does its own hashing — it touches neither the
  // Supabase client nor the session.
  // ---------------------------------------------------------------------
  const { pathname } = request.nextUrl;
  const hasSession = Boolean(data?.claims);

  if (startsWithAny(pathname, UNGATED_PATHS)) {
    return supabaseResponse;
  }

  if (hasSession) {
    // Signed in: the gate and the auth surfaces are noise. Send them home.
    if (pathname === GATE_PATH || startsWithAny(pathname, GATED_AUTH_PATHS)) {
      return divert(NextResponse.redirect(redirectUrl(request, "/")), supabaseResponse);
    }
    return supabaseResponse;
  }

  const gateCleared = await isGateCookieValid(
    request.cookies.get(GATE_COOKIE_NAME)?.value,
    env.ACCESS_CODE,
  );

  if (!gateCleared) {
    // The access-code screen is the only thing an ungated visitor may see, and
    // it lives at the domain root. Rewrite rather than redirect so the URL
    // stays `/` — the gate should not advertise that a `/gate` route exists.
    if (pathname === "/") {
      return divert(NextResponse.rewrite(rewriteUrl(request, GATE_PATH)), supabaseResponse);
    }
    return divert(NextResponse.redirect(redirectUrl(request, "/")), supabaseResponse);
  }

  // Gate cleared, still signed out: the auth surfaces are open, nothing else is.
  if (startsWithAny(pathname, GATED_AUTH_PATHS)) {
    return supabaseResponse;
  }
  return divert(NextResponse.redirect(redirectUrl(request, "/login")), supabaseResponse);
}

/** Same origin, new path, query preserved — the gate reads `?status=` from it. */
function rewriteUrl(request: NextRequest, pathname: string): URL {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  return url;
}

/** Same origin, new path, query dropped so stale params never ride along. */
function redirectUrl(request: NextRequest, pathname: string): URL {
  const url = rewriteUrl(request, pathname);
  url.search = "";
  return url;
}
