import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthPanel } from "@/components/auth/auth-panel";
import { UpdatePasswordForm } from "@/components/auth/update-password-form";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Set a new password",
  robots: { index: false, follow: false },
};

/**
 * The second half of a password reset. Reached only from the emailed link:
 * `/auth/confirm` verifies the recovery token, which mints a session, and sends
 * the visitor here.
 *
 * `/auth/*` is deliberately outside the access-code gate (an emailed link is
 * followed on whatever device is to hand), so this page guards ITSELF on the
 * session rather than relying on the proxy.
 */
export default async function UpdatePasswordPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) {
    redirect("/login?status=expired");
  }

  return (
    <AuthPanel title="Set a new password" lead="This replaces the password on your account.">
      <UpdatePasswordForm />
    </AuthPanel>
  );
}
