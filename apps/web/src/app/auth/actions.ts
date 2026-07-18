"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { emailSchema, existingPasswordSchema, passwordSchema } from "@/lib/auth/password";
import { type FormState, formError, toFormState } from "@/lib/forms/form-state";
import { createClient } from "@/lib/supabase/server";

/**
 * Auth Server Actions. Every one of them parses its FormData through Zod
 * before anything reaches Supabase — the boundary rule in CLAUDE.md.
 *
 * Failures RETURN a `FormState`; they do not redirect. A redirect remounts the
 * route and wipes every field the visitor typed, which is WCAG 2.2 SC 3.3.7
 * (Redundant Entry). Success still redirects, because that is a real navigation.
 *
 * Statuses stay deliberately coarse on the sign-in path: "wrong email" and
 * "wrong password" collapse into one form-level message, attached to no field,
 * so the form is not an account-enumeration oracle.
 *
 * Only the actions the forms actually post to are exported: every export of a
 * `"use server"` module is a callable endpoint, so helpers stay module-private.
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

/** The email is the only value ever echoed back into `values` — never a password. */
function submittedEmail(formData: FormData): Record<string, string> {
  const email = formData.get("email");
  return typeof email === "string" ? { email } : {};
}

const RATE_LIMITED = "An email went out recently. Give it a minute, then try again.";
const GENERIC_FAILURE = "Something went wrong. Please try again.";
const WEAK_PASSWORD = "That password was rejected as too weak. Try a longer, less predictable one.";

const emailOnlySchema = z.object({ email: emailSchema });

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

const updatePasswordSchema = z
  .object({ password: passwordSchema, confirmPassword: z.string() })
  .refine((value) => value.password === value.confirmPassword, {
    path: ["confirmPassword"],
    message: "Those two passwords do not match.",
  });

/** Secondary path on the sign-in form: a one-time sign-in link. */
async function sendMagicLink(formData: FormData): Promise<FormState> {
  const values = submittedEmail(formData);
  const parsed = emailOnlySchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return toFormState(parsed.error, values);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: { emailRedirectTo: `${await requestOrigin()}/auth/callback` },
  });

  if (!error) {
    return {
      status: "success",
      message: "Check your inbox — a one-time sign-in link is on its way.",
      values,
    };
  }
  if (error.code === "over_email_send_rate_limit") {
    return { status: "info", message: RATE_LIMITED, values };
  }
  return formError(GENERIC_FAILURE, values);
}

/**
 * Email + password sign-in, plus the magic-link path.
 *
 * Both live on one form so the email is typed once, and one action serves both
 * so `useActionState` has a single state to own. The magic-link submit button
 * carries `name="intent" value="magic-link"` — a submitter's own name/value is
 * how it tells the action which of a form's two jobs it is asking for.
 */
export async function signIn(_previous: FormState, formData: FormData): Promise<FormState> {
  if (formData.get("intent") === "magic-link") {
    return sendMagicLink(formData);
  }

  const values = submittedEmail(formData);
  const parsed = credentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return toFormState(parsed.error, values);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (!error) {
    redirect("/");
  }
  if (error.code === "email_not_confirmed") {
    return formError("Confirm your email first — the link is in your inbox.", values);
  }
  // Form-level, and attached to NO field: naming the wrong half would leak
  // whether the address is registered.
  return formError("That email and password don't match an account.", values);
}

/** Self-serve sign-up. Supabase emails a confirmation via the Resend hook. */
export async function signUp(_previous: FormState, formData: FormData): Promise<FormState> {
  const values = submittedEmail(formData);
  const parsed = signUpSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) {
    return toFormState(parsed.error, values);
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
    return {
      status: "success",
      message:
        "Account created. Confirm your email address from the link we just sent, then sign in.",
      values,
    };
  }
  if (error.code === "over_email_send_rate_limit") {
    return { status: "info", message: RATE_LIMITED, values };
  }
  if (error.code === "weak_password") {
    return { status: "error", fieldErrors: { password: WEAK_PASSWORD }, values };
  }
  return formError(GENERIC_FAILURE, values);
}

/**
 * Starts a password reset. Always reports success — telling the visitor whether
 * an address is registered would be an enumeration oracle.
 */
export async function requestPasswordReset(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const values = submittedEmail(formData);
  const parsed = emailOnlySchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return toFormState(parsed.error, values);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${await requestOrigin()}/auth/update-password`,
  });

  if (error?.code === "over_email_send_rate_limit") {
    return { status: "info", message: RATE_LIMITED, values };
  }
  return {
    status: "success",
    message: "If that address has an account, a reset link is on its way to it.",
    values,
  };
}

/** Finishes a password reset. Requires the recovery session /auth/confirm minted. */
export async function updatePassword(_previous: FormState, formData: FormData): Promise<FormState> {
  const parsed = updatePasswordSchema.safeParse({
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) {
    // No `values`: both fields here are passwords, and a password is never
    // echoed back into the document.
    return toFormState(parsed.error);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });

  if (!error) {
    redirect("/");
  }
  if (error.code === "weak_password") {
    return { status: "error", fieldErrors: { password: WEAK_PASSWORD } };
  }
  return formError(GENERIC_FAILURE);
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
