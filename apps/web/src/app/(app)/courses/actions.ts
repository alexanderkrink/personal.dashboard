"use server";

import type { SupabaseServerClient } from "@study/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUserId } from "@/lib/auth/require-user";
import { COURSE_FIELDS, courseSchema, rowIdSchema } from "@/lib/courses/schemas";
import { type FormState, formError, toFormState } from "@/lib/forms/form-state";
import { readFormValues } from "@/lib/forms/form-values";
import { createClient } from "@/lib/supabase/server";

/**
 * Course writes.
 *
 * Every export of a `"use server"` module is a publicly callable endpoint, so
 * helpers stay module-private and every one of these re-derives the user from
 * the session rather than trusting anything in the `FormData`.
 *
 * Reads are RSC; these are the only paths that write. All of them use the
 * request-scoped `createClient()` so RLS applies — `createAdminSupabaseClient`
 * bypasses it and belongs to background jobs only (PLAN "RLS strategy" §3).
 */

const SAVE_FAILED = "That didn’t save. Try again — nothing you typed was lost.";
const NOT_FOUND = "That course no longer exists. It may have been deleted in another tab.";

/**
 * Confirms a semester is one the caller can actually see.
 *
 * `courses.semester_id` is a plain foreign key: RLS governs which *courses* a
 * user can write, but nothing stops a posted `semester_id` from naming another
 * account's term, and the FK would happily accept it. Reading the row back
 * through the session-scoped client is the check — the select policy makes a
 * row that is not yours indistinguishable from one that does not exist.
 */
async function ownsSemester(supabase: SupabaseServerClient, semesterId: string): Promise<boolean> {
  const { data } = await supabase.from("semesters").select("id").eq("id", semesterId).maybeSingle();
  return data !== null;
}

/** camelCase form field → snake_case column. The one place the hop happens. */
function courseRow(input: ReturnType<typeof courseSchema.parse>) {
  return {
    semester_id: input.semesterId,
    code: input.code,
    title: input.title,
    color: input.color,
    credits: input.credits,
    target_grade: input.targetGrade,
    grading_scale: input.gradingScale,
    participation_weight: input.participationWeight,
    absence_fail_pct: input.absenceFailPct,
    participation_target: input.participationTarget,
  };
}

export async function createCourse(_previous: FormState, formData: FormData): Promise<FormState> {
  const values = readFormValues(formData, COURSE_FIELDS);
  const parsed = courseSchema.safeParse(values);
  if (!parsed.success) return toFormState(parsed.error, values);

  const supabase = await createClient();
  const userId = await requireUserId(supabase);

  if (parsed.data.semesterId && !(await ownsSemester(supabase, parsed.data.semesterId))) {
    return {
      status: "error",
      fieldErrors: { semesterId: "Pick a semester from the list." },
      values,
    };
  }

  const { data, error } = await supabase
    .from("courses")
    .insert({ ...courseRow(parsed.data), user_id: userId })
    .select("id")
    .single();

  if (error || !data) return formError(SAVE_FAILED, values);

  revalidatePath("/courses");
  redirect(`/courses/${data.id}`);
}

export async function updateCourse(_previous: FormState, formData: FormData): Promise<FormState> {
  const values = readFormValues(formData, COURSE_FIELDS);
  const id = rowIdSchema.safeParse(formData.get("courseId"));
  if (!id.success) return formError(NOT_FOUND, values);

  const parsed = courseSchema.safeParse(values);
  if (!parsed.success) return toFormState(parsed.error, values);

  const supabase = await createClient();
  await requireUserId(supabase);

  if (parsed.data.semesterId && !(await ownsSemester(supabase, parsed.data.semesterId))) {
    return {
      status: "error",
      fieldErrors: { semesterId: "Pick a semester from the list." },
      values,
    };
  }

  // No `.eq("user_id", …)`: the update policy's `using` clause already scopes
  // this to the caller's rows, so somebody else's course matches nothing. The
  // `select` is what turns "matched nothing" into a sentence instead of a
  // silent success.
  const { data, error } = await supabase
    .from("courses")
    .update(courseRow(parsed.data))
    .eq("id", id.data)
    .select("id")
    .maybeSingle();

  if (error) return formError(SAVE_FAILED, values);
  if (!data) return formError(NOT_FOUND, values);

  revalidatePath("/courses");
  revalidatePath(`/courses/${id.data}`);
  redirect(`/courses/${id.data}`);
}

/**
 * Archives or restores a course.
 *
 * Archiving, not deleting: a course is the spine that documents, topics, cards
 * and calendar items all hang off, so removing it would take a semester of
 * history with it. `archived` just moves it out of the way, and the same action
 * serves both directions via the submitter's `intent`.
 */
export async function setCourseArchived(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const id = rowIdSchema.safeParse(formData.get("courseId"));
  if (!id.success) return formError(NOT_FOUND);

  const archived = formData.get("intent") === "archive";

  const supabase = await createClient();
  await requireUserId(supabase);

  const { data, error } = await supabase
    .from("courses")
    .update({ archived })
    .eq("id", id.data)
    .select("id")
    .maybeSingle();

  if (error) return formError(SAVE_FAILED);
  if (!data) return formError(NOT_FOUND);

  revalidatePath("/courses");
  revalidatePath(`/courses/${id.data}`);

  return {
    status: "info",
    message: archived
      ? "Archived. It’s out of the way — nothing was deleted."
      : "Back in the active list.",
  };
}
