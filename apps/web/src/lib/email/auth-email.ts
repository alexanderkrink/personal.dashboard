/**
 * Auth email content, rendered by us and sent via Resend — Supabase's
 * email templates are not used (Send Email Hook replaces them entirely).
 */

export type EmailActionType =
  | "signup"
  | "magiclink"
  | "recovery"
  | "invite"
  | "email_change"
  | "email";

const COPY: Record<string, { subject: string; heading: string; body: string; cta: string }> = {
  signup: {
    subject: "Confirm your email · Study Dashboard",
    heading: "Confirm your email",
    body: "Follow the link below to confirm your email address and sign in to Study Dashboard.",
    cta: "Confirm and sign in",
  },
  magiclink: {
    subject: "Your sign-in link · Study Dashboard",
    heading: "Sign in to Study Dashboard",
    body: "Follow the link below to sign in. This link can only be used once.",
    cta: "Sign in to Study Dashboard",
  },
  recovery: {
    subject: "Reset your password · Study Dashboard",
    heading: "Reset your password",
    body: "Follow the link below to reset your password.",
    cta: "Reset password",
  },
  email_change: {
    subject: "Confirm your new email · Study Dashboard",
    heading: "Confirm your new email",
    body: "Follow the link below to confirm your new email address.",
    cta: "Confirm new email",
  },
};

const FALLBACK = COPY.magiclink as NonNullable<(typeof COPY)[string]>;

export function getAuthEmailSubject(actionType: string): string {
  return (COPY[actionType] ?? FALLBACK).subject;
}

export function renderAuthEmail(actionType: string, url: string): string {
  const copy = COPY[actionType] ?? FALLBACK;

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background-color:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f5f5;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background-color:#ffffff;border-radius:12px;border:1px solid #e5e5e5;padding:32px;">
            <tr><td style="font-size:20px;font-weight:600;color:#171717;padding-bottom:8px;">Study Dashboard</td></tr>
            <tr><td style="font-size:16px;font-weight:600;color:#171717;padding-bottom:8px;">${copy.heading}</td></tr>
            <tr><td style="font-size:14px;color:#525252;line-height:1.6;padding-bottom:24px;">${copy.body}</td></tr>
            <tr>
              <td style="padding-bottom:24px;">
                <a href="${url}" style="display:inline-block;background-color:#2563eb;color:#ffffff;font-size:14px;font-weight:500;text-decoration:none;padding:10px 20px;border-radius:6px;">${copy.cta}</a>
              </td>
            </tr>
            <tr><td style="font-size:12px;color:#a3a3a3;line-height:1.6;">If the button doesn't work, copy this link into your browser:<br/><a href="${url}" style="color:#525252;word-break:break-all;">${url}</a></td></tr>
            <tr><td style="font-size:12px;color:#a3a3a3;padding-top:24px;">If you didn't request this email, you can safely ignore it.</td></tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
