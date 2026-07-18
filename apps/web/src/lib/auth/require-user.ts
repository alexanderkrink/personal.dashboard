import type { SupabaseServerClient } from "@study/db";
import { redirect } from "next/navigation";

/**
 * The signed-in user's id, or a redirect to the sign-in form.
 *
 * Every write in the app needs this for two different reasons, and it is worth
 * being explicit about both:
 *
 *  1. **Authorization is RLS's job, not this function's.** The insert policies
 *     on `semesters` / `courses` / `assessments` are
 *     `with check ((select auth.uid()) = user_id)`, so a row stamped with
 *     somebody else's id is rejected by the database no matter what this
 *     returns. Removing this call could not smuggle a row into another
 *     account.
 *  2. **`user_id` is `not null`,** so an insert has to carry *some* id, and it
 *     may as well be the verified one. Getting here without a session means the
 *     session expired mid-form, and a redirect to `/login` is a better answer
 *     than a constraint violation.
 *
 * `getClaims()` — not `getSession()` — because it verifies the JWT signature
 * rather than trusting whatever is in the cookie. `sub` is the user id.
 */
export async function requireUserId(supabase: SupabaseServerClient): Promise<string> {
  const { data, error } = await supabase.auth.getClaims();
  const sub = data?.claims.sub;

  if (error || typeof sub !== "string" || sub.length === 0) {
    redirect("/login");
  }

  return sub;
}
