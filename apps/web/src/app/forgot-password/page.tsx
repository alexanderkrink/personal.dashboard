import type { Metadata } from "next";
import Link from "next/link";
import { requestPasswordReset } from "@/app/auth/actions";
import { AuthPanel } from "@/components/auth/auth-panel";
import { AuthStatus, type AuthStatusTone } from "@/components/auth/auth-status";
import { SubmitButton } from "@/components/submit-button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export const metadata: Metadata = {
  title: "Reset your password",
  robots: { index: false, follow: false },
};

const STATUS: Record<string, { tone: AuthStatusTone; message: string }> = {
  // Shown whether or not the address is registered — see the action's comment.
  "check-inbox": {
    tone: "success",
    message: "If that address has an account, a reset link is on its way to it.",
  },
  "invalid-email": { tone: "error", message: "That doesn't look like a valid email address." },
  "rate-limited": {
    tone: "info",
    message: "An email went out recently. Give it a minute, then try again.",
  },
};

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const banner = status ? STATUS[status] : undefined;

  return (
    <AuthPanel
      title="Reset your password"
      lead="We'll email you a link to set a new one."
      footer={
        <Link href="/login" className="text-accent-text underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      }
    >
      <form action={requestPasswordReset} className="flex flex-col gap-5">
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
          />
        </Field>

        {banner ? <AuthStatus tone={banner.tone}>{banner.message}</AuthStatus> : null}

        <SubmitButton className="h-9 w-full" pendingLabel="Sending…">
          Send reset link
        </SubmitButton>
      </form>
    </AuthPanel>
  );
}
