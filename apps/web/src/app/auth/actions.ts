"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const loginSchema = z.object({
  email: z.email(),
});

/** Sends a magic sign-in link to the given email. */
export async function login(formData: FormData) {
  const parsed = loginSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    redirect("/login?status=invalid-email");
  }

  const supabase = await createClient();
  const origin = (await headers()).get("origin");

  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: {
      emailRedirectTo: `${origin}/auth/callback`,
    },
  });

  if (!error) {
    redirect("/login?status=sent");
  }
  redirect(
    error.code === "over_email_send_rate_limit"
      ? "/login?status=rate-limited"
      : "/login?status=error",
  );
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
