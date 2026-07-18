import type { Metadata } from "next";
import Link from "next/link";
import { signUp } from "@/app/auth/actions";
import { AuthPanel } from "@/components/auth/auth-panel";
import { AuthStatus, type AuthStatusTone } from "@/components/auth/auth-status";
import { PasswordField } from "@/components/auth/password-field";
import { SubmitButton } from "@/components/submit-button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export const metadata: Metadata = {
  title: "Create an account",
  robots: { index: false, follow: false },
};

const STATUS: Record<string, { tone: AuthStatusTone; message: string }> = {
  "check-inbox": {
    tone: "success",
    message:
      "Account created. Confirm your email address from the link we just sent, then sign in.",
  },
  "weak-password": {
    tone: "error",
    message: "That password was rejected as too weak. Try a longer, less predictable one.",
  },
  "rate-limited": {
    tone: "info",
    message: "An email went out recently. Give it a minute, then try again.",
  },
  error: { tone: "error", message: "Something went wrong. Please try again." },
};

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; message?: string }>;
}) {
  const { status, message } = await searchParams;

  const banner =
    status === "invalid" && message
      ? ({ tone: "error", message } as const)
      : status
        ? STATUS[status]
        : undefined;

  return (
    <AuthPanel
      title="Create an account"
      lead="You'll confirm your email before you can sign in."
      footer={
        <>
          Already have one?{" "}
          <Link href="/login" className="text-accent-text underline-offset-4 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form action={signUp} className="flex flex-col gap-5">
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

        <PasswordField name="password" label="Password" />

        <Field>
          <FieldLabel htmlFor="confirmPassword">Confirm password</FieldLabel>
          <Input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            required
            autoComplete="new-password"
          />
        </Field>

        {banner ? <AuthStatus tone={banner.tone}>{banner.message}</AuthStatus> : null}

        <SubmitButton className="h-9 w-full" pendingLabel="Creating…">
          Create account
        </SubmitButton>
      </form>
    </AuthPanel>
  );
}
