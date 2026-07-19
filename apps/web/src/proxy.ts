import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy-session";

export default async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except static assets:
     * - _next/static, _next/image
     * - favicon.ico and common image/font files
     * - manifest.webmanifest — the extension list below does not cover it, and without
     *   this the session check 307s the manifest to `/` for any signed-out visitor. The
     *   browser fetches the manifest before there is a session, so the redirect makes the
     *   app permanently non-installable and devtools reports the manifest as invalid.
     */
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)",
  ],
};
