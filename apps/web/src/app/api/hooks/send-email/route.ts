import { NextResponse } from "next/server";
import { Resend } from "resend";
import { Webhook } from "standardwebhooks";
import { z } from "zod";
import { env } from "@/env";
import { getAuthEmailSubject, renderAuthEmail } from "@/lib/email/auth-email";

/**
 * Supabase Auth "Send Email" hook. Supabase POSTs a signed payload here
 * instead of sending auth emails itself; we render and send via Resend.
 * Configure in Supabase: Authentication → Hooks → Send Email → HTTPS →
 * https://<production-domain>/api/hooks/send-email
 */

const hookPayloadSchema = z.object({
  user: z.object({ email: z.email() }),
  email_data: z.object({
    token_hash: z.string().min(1),
    email_action_type: z.string().min(1),
    redirect_to: z.string().default(""),
    site_url: z.string().default(""),
  }),
});

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  if (!env.SEND_EMAIL_HOOK_SECRET || !env.RESEND_API_KEY) {
    return NextResponse.json(
      { error: "Email hook not configured: set SEND_EMAIL_HOOK_SECRET and RESEND_API_KEY" },
      { status: 500 },
    );
  }

  const payload = await request.text();
  const webhook = new Webhook(env.SEND_EMAIL_HOOK_SECRET.replace("v1,whsec_", ""));

  let verified: unknown;
  try {
    verified = webhook.verify(payload, {
      "webhook-id": request.headers.get("webhook-id") ?? "",
      "webhook-timestamp": request.headers.get("webhook-timestamp") ?? "",
      "webhook-signature": request.headers.get("webhook-signature") ?? "",
    });
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const parsed = hookPayloadSchema.safeParse(verified);
  if (!parsed.success) {
    return NextResponse.json({ error: "Unexpected payload shape" }, { status: 400 });
  }
  const { user, email_data: emailData } = parsed.data;

  // Build the token-hash confirmation link against the origin the user is on
  // (localhost in dev, preview, or production) — /auth/confirm verifies it
  // server-side, so no cookies or URL fragments are involved.
  const base = originOf(emailData.redirect_to) ?? originOf(emailData.site_url);
  if (!base) {
    return NextResponse.json({ error: "No usable redirect origin" }, { status: 400 });
  }
  const confirmUrl = new URL("/auth/confirm", base);
  confirmUrl.searchParams.set("token_hash", emailData.token_hash);
  confirmUrl.searchParams.set("type", emailData.email_action_type);

  const resend = new Resend(env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: env.EMAIL_FROM ?? "StudyOS <onboarding@resend.dev>",
    to: user.email,
    subject: getAuthEmailSubject(emailData.email_action_type),
    html: renderAuthEmail(emailData.email_action_type, confirmUrl.toString()),
  });

  if (error) {
    return NextResponse.json({ error: `Resend: ${error.message}` }, { status: 500 });
  }
  return NextResponse.json({});
}
