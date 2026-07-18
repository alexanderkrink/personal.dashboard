import type { Metadata } from "next";
import Link from "next/link";
import { AuthPanel } from "@/components/auth/auth-panel";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";

export const metadata: Metadata = {
  title: "Reset your password",
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return (
    <AuthPanel
      title="Reset your password"
      lead="We'll email you a link to set a new one."
      footer={
        <Link
          href="/login"
          className="focus-ring rounded-sm text-accent-text underline-offset-4 hover:underline"
        >
          Back to sign in
        </Link>
      }
    >
      <ForgotPasswordForm />
    </AuthPanel>
  );
}
