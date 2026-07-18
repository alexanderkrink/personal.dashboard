import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { updatePassword } from "@/app/auth/actions";
import { AuthPanel } from "@/components/auth/auth-panel";
import { AuthStatus, type AuthStatusTone } from "@/components/auth/auth-status";
import { PasswordField } from "@/components/auth/password-field";
import { SubmitButton } from "@/components/submit-button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Set a new password",
  robots: { index: false, follow: false },
};

const STATUS: Record<string, { tone: AuthStatusTone; message: string }> = {
  "weak-password": {
    tone: "error",
    message: "That password was rejected as too weak. Try a longer, less predictable one.",
  },
  error: { tone: "error", message: "Something went wrong. Please try again." },
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
export default async function UpdatePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; message?: string }>;
}) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) {
    redirect("/login?status=expired");
  }

  const { status, message } = await searchParams;
  const banner =
    status === "invalid" && message
      ? ({ tone: "error", message } as const)
      : status
        ? STATUS[status]
        : undefined;

  return (
    <AuthPanel title="Set a new password" lead="This replaces the password on your account.">
      <form action={updatePassword} className="flex flex-col gap-5">
        <PasswordField name="password" label="New password" />

        <Field>
          <FieldLabel htmlFor="confirmPassword">Confirm new password</FieldLabel>
          <Input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            required
            autoComplete="new-password"
          />
        </Field>

        {banner ? <AuthStatus tone={banner.tone}>{banner.message}</AuthStatus> : null}

        <SubmitButton className="h-9 w-full" pendingLabel="Saving…">
          Save new password
        </SubmitButton>
      </form>
    </AuthPanel>
  );
}
