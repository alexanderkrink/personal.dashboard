import type { Metadata } from "next";
import Link from "next/link";
import { AuthPanel } from "@/components/auth/auth-panel";
import { SignInForm } from "@/components/auth/sign-in-form";
import type { FormStatusTone } from "@/components/form/form-status";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

/**
 * The only statuses left on the query string are the ones that genuinely arrive
 * by NAVIGATION — another route sent the visitor here and said why. Everything
 * this form can fail at itself now comes back as a `FormState` from the action
 * instead, so a failed submit no longer wipes the fields (WCAG 2.2 SC 3.3.7).
 */
const STATUS: Record<string, { tone: FormStatusTone; message: string }> = {
  expired: { tone: "error", message: "That link has expired. Request a new one." },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;

  return (
    <AuthPanel
      title="Sign in"
      lead="Email and password."
      footer={
        <>
          No account yet?{" "}
          <Link
            href="/signup"
            className="focus-ring rounded-sm text-accent-text underline-offset-4 hover:underline"
          >
            Create one
          </Link>
        </>
      }
    >
      <SignInForm fallback={status ? STATUS[status] : undefined} />
    </AuthPanel>
  );
}
