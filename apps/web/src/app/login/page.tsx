import type { Metadata } from "next";
import Link from "next/link";
import { sendMagicLink, signIn } from "@/app/auth/actions";
import { AuthPanel } from "@/components/auth/auth-panel";
import { AuthStatus, type AuthStatusTone } from "@/components/auth/auth-status";
import { SubmitButton } from "@/components/submit-button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

const STATUS: Record<string, { tone: AuthStatusTone; message: string }> = {
  // Deliberately one message for "no such account" and "wrong password" —
  // splitting them would turn this form into an account-enumeration oracle.
  "invalid-credentials": {
    tone: "error",
    message: "That email and password don't match an account.",
  },
  "invalid-email": { tone: "error", message: "That doesn't look like a valid email address." },
  unconfirmed: {
    tone: "error",
    message: "Confirm your email first — the link is in your inbox.",
  },
  "link-sent": {
    tone: "success",
    message: "Check your inbox — a one-time sign-in link is on its way.",
  },
  "rate-limited": {
    tone: "info",
    message: "An email went out recently. Give it a minute, then try again.",
  },
  expired: { tone: "error", message: "That link has expired. Request a new one." },
  error: { tone: "error", message: "Something went wrong. Please try again." },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const banner = status ? STATUS[status] : undefined;

  return (
    <AuthPanel
      title="Sign in"
      lead="Email and password."
      footer={
        <>
          No account yet?{" "}
          <Link href="/signup" className="text-accent-text underline-offset-4 hover:underline">
            Create one
          </Link>
        </>
      }
    >
      <form action={signIn} className="flex flex-col gap-5">
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

        <Field>
          <div className="flex items-baseline justify-between gap-3">
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Link
              href="/forgot-password"
              className="text-accent-text text-ui-sm underline-offset-4 hover:underline"
            >
              Forgot?
            </Link>
          </div>
          <Input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
          />
        </Field>

        {banner ? <AuthStatus tone={banner.tone}>{banner.message}</AuthStatus> : null}

        <SubmitButton className="h-9 w-full" pendingLabel="Signing in…">
          Sign in
        </SubmitButton>

        <div className="flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-muted-foreground text-ui-sm">or</span>
          <Separator className="flex-1" />
        </div>

        {/*
          The secondary path. It posts THIS form to a different Server Action, so
          the email above is reused rather than typed twice. `formNoValidate`
          suppresses the browser's required-field check on the password, which
          this action does not need.
        */}
        <SubmitButton
          variant="outline"
          className="h-9 w-full"
          formAction={sendMagicLink}
          formNoValidate
          pendingLabel="Sending…"
        >
          Email me a sign-in link
        </SubmitButton>
      </form>
    </AuthPanel>
  );
}
