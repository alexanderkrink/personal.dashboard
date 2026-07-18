import type { Metadata } from "next";
import Link from "next/link";
import { AuthPanel } from "@/components/auth/auth-panel";
import { SignUpForm } from "@/components/auth/sign-up-form";

export const metadata: Metadata = {
  title: "Create an account",
  robots: { index: false, follow: false },
};

export default function SignupPage() {
  return (
    <AuthPanel
      title="Create an account"
      lead="You'll confirm your email before you can sign in."
      footer={
        <>
          Already have one?{" "}
          <Link
            href="/login"
            className="focus-ring rounded-sm text-accent-text underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
        </>
      }
    >
      <SignUpForm />
    </AuthPanel>
  );
}
