"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { env } from "@/env";
import {
  GATE_COOKIE_MAX_AGE,
  GATE_COOKIE_NAME,
  gateCookieToken,
  isAccessCodeValid,
} from "@/lib/auth/access-code";

/**
 * Cap the submitted length before hashing so a multi-megabyte "code" cannot be
 * used to burn CPU. Any real code is far shorter.
 */
const submissionSchema = z.object({ code: z.string().min(1).max(256) });

/**
 * Checks the access code and, if it matches, mints the gate cookie.
 *
 * The attempt is never logged and the submitted value is never echoed back —
 * not into a redirect query, not into a console line. A wrong code produces one
 * indistinguishable outcome regardless of how nearly it matched.
 */
export async function unlock(formData: FormData) {
  const parsed = submissionSchema.safeParse({ code: formData.get("code") });

  if (!parsed.success || !(await isAccessCodeValid(parsed.data.code, env.ACCESS_CODE))) {
    redirect("/?status=invalid");
  }

  const cookieStore = await cookies();
  cookieStore.set({
    name: GATE_COOKIE_NAME,
    value: await gateCookieToken(env.ACCESS_CODE),
    httpOnly: true,
    // Playwright and `next dev` both serve plain http on localhost; a hard
    // `secure: true` would make the cookie unsettable there.
    secure: process.env.NODE_ENV === "production",
    // `lax`, not `strict`: a confirmation link followed from an email client is
    // a cross-site navigation, and `strict` would withhold the cookie from it.
    sameSite: "lax",
    path: "/",
    maxAge: GATE_COOKIE_MAX_AGE,
  });

  redirect("/login");
}
