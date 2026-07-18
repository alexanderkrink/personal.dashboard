"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { emailSchema, existingPasswordSchema, passwordSchema } from "@/lib/auth/password";
import { createClient } from "@/lib/supabase/server";

/**
 * Auth Server Actions. Every one of them parses its FormData through Zod
 * before anything reaches Supabase — the boundary rule in CLAUDE.md — and
 * reports back by redirecting with a `?status=` code that the page maps to
 * copy. Statuses are deliberately coarse on the sign-in path: "wrong email" and
 * "wrong password" collapse into one message so the form is not an account
 * enumeration oracle.
 */

/**
 * The origin the visitor is actually on — localhost in dev, the preview host on
 * Vercel, the real domain in production — so email links come back to the same
 * place. Server Action POSTs always carry `origin`; the host headers are a
 * belt-and-braces fallback.
 */
async function requestOrigin(): Promise<string> {
  const headerList = await headers();
  const origin = headerList.get("origin");
  if (origin) return origin;

  const host = headerList.get("x-forwarded-host") ?? headerList.get("host");
  const protocol = headerList.get("x-forwarded-proto") ?? "https";
  return host ? `${protocol}://${host}` : "";
}

const credentialsSchema = z.object({
  email: emailSchema,
  password: existingPasswordSchema,
});

const signUpSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    path: ["confirmPassword"],
    message: "Those two passwords do not match.",
  });

/** Email + password sign-in. */
export async function signIn(formData: FormData) {
  const parsed = credentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    redirect("/login?status=invalid-credentials");
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (!error) {
    redirect("/");
  }
  if (error.code === "email_not_confirmed") {
    redirect("/login?status=unconfirmed");
  }
  redirect("/login?status=invalid-credentials");
}

/** Self-serve sign-up. Supabase emails a confirmation via the Resend hook. */
export async function signUp(formData: FormData) {
  const parsed = signUpSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    redirect(`/signup?status=invalid&message=${encodeURIComponent(issue?.message ?? "")}`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    // Only the ORIGIN of this matters: the Send Email hook rebuilds the link as
    // /auth/confirm?token_hash=…&type=signup against it.
    options: { emailRedirectTo: `${await requestOrigin()}/auth/confirm` },
  });

  if (!error) {
    redirect("/signup?status=check-inbox");
  }
  if (error.code === "over_email_send_rate_limit") {
    redirect("/signup?status=rate-limited");
  }
  if (error.code === "weak_password") {
    redirect("/signup?status=weak-password");
  }
  redirect("/signup?status=error");
}

/** Secondary path: a one-time sign-in link, for when the password is forgotten mid-flow. */
export async function sendMagicLink(formData: FormData) {
  const parsed = emailSchema.safeParse(formData.get("email"));
  if (!parsed.success) {
    redirect("/login?status=invalid-email");
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data,
    options: { emailRedirectTo: `${await requestOrigin()}/auth/callback` },
  });

  if (!error) {
    redirect("/login?status=link-sent");
  }
  redirect(
    error.code === "over_email_send_rate_limit"
      ? "/login?status=rate-limited"
      : "/login?status=error",
  );
}

/**
 * Starts a password reset. Always reports success — telling the visitor whether
 * an address is registered would be an enumeration oracle.
 */
export async function requestPasswordReset(formData: FormData) {
  const parsed = emailSchema.safeParse(formData.get("email"));
  if (!parsed.success) {
    redirect("/forgot-password?status=invalid-email");
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data, {
    redirectTo: `${await requestOrigin()}/auth/update-password`,
  });

  if (error?.code === "over_email_send_rate_limit") {
    redirect("/forgot-password?status=rate-limited");
  }
  redirect("/forgot-password?status=check-inbox");
}

const updatePasswordSchema = z
  .object({ password: passwordSchema, confirmPassword: z.string() })
  .refine((value) => value.password === value.confirmPassword, {
    path: ["confirmPassword"],
    message: "Those two passwords do not match.",
  });

/** Finishes a password reset. Requires the recovery session /auth/confirm minted. */
export async function updatePassword(formData: FormData) {
  const parsed = updatePasswordSchema.safeParse({
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    redirect(
      `/auth/update-password?status=invalid&message=${encodeURIComponent(issue?.message ?? "")}`,
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });

  if (!error) {
    redirect("/");
  }
  if (error.code === "weak_password") {
    redirect("/auth/update-password?status=weak-password");
  }
  redirect("/auth/update-password?status=error");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
