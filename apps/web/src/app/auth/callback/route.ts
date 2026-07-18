import { NextResponse } from "next/server";
import { safeNext } from "@/lib/auth/safe-next";
import { createClient } from "@/lib/supabase/server";

/** PKCE code exchange — target of the magic-link redirect. */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // Caller-supplied; resolved back to a same-origin path rather than
  // concatenated. See lib/auth/safe-next.ts.
  const next = safeNext(searchParams.get("next"), origin, "/");

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(new URL(next, origin));
    }
  }

  return NextResponse.redirect(`${origin}/login?status=error`);
}
