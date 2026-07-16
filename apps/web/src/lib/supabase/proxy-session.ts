import { createServerSupabaseClient } from "@studyos/db";
import { type NextRequest, NextResponse } from "next/server";
import { env } from "@/env";

/** Route prefixes reachable without a session. */
const PUBLIC_PATHS = ["/login", "/auth", "/api/hooks"];

/**
 * Refreshes the Supabase session on every request and redirects
 * unauthenticated users to /login. Called from src/proxy.ts.
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

  const isPublicPath = PUBLIC_PATHS.some((path) => request.nextUrl.pathname.startsWith(path));

  if (!data?.claims && !isPublicPath) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
