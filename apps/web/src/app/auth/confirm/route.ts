import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { safeNext } from "@/lib/auth/safe-next";
import { createClient } from "@/lib/supabase/server";

/**
 * OTP token verification — the landing route for every auth email we send.
 * The Send Email hook (`/api/hooks/send-email`) builds every link as
 * `/auth/confirm?token_hash=…&type=…`, so signup confirmation, magic links and
 * password recovery all arrive here.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  // A recovery token buys exactly one thing: the right to set a new password.
  // Everything else lands on the dashboard. `next` is caller-supplied, so it is
  // resolved back to a same-origin path rather than concatenated — see
  // lib/auth/safe-next.ts for why concatenation is not safe here.
  const next = safeNext(
    searchParams.get("next"),
    origin,
    type === "recovery" ? "/auth/update-password" : "/",
  );

  if (tokenHash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      return NextResponse.redirect(new URL(next, origin));
    }
  }

  // An expired or already-used link is the overwhelmingly likely cause.
  return NextResponse.redirect(`${origin}/login?status=expired`);
}
