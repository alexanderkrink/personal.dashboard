"use server";

import type { SupabaseServerClient } from "@study/db";
import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth/require-user";
import { ASSESSMENT_FIELDS, assessmentSchema, rowIdSchema } from "@/lib/courses/schemas";
import { type FormState, formError, toFormState } from "@/lib/forms/form-state";
import { readFormValues } from "@/lib/forms/form-values";
import { createClient } from "@/lib/supabase/server";

/**
 * Assessment writes — the graded components of one course.
 *
 * These never redirect. Adding four components to a syllabus is one sitting,
 * and a navigation between each would be hostile; success returns state, the
 * page revalidates, and the running weight total updates underneath.
 *
 * Nothing here blocks on the weight total. A syllabus legitimately does not
 * always add up to 100 — extra credit, "best 3 of 4", a lecturer who rounded —
 * and the person holding it knows more than this code does. The total is
 * surfaced and, when it drifts, warned about; it is never a gate.
 */

const SAVE_FAILED = "That didn’t save. Try again — nothing you typed was lost.";
const NOT_FOUND = "That component no longer exists. It may have been deleted in another tab.";
const NO_COURSE = "That course no longer exists.";

/** Blank strings for every field — what a successful create echoes back. */
const CLEARED = Object.fromEntries(ASSESSMENT_FIELDS.map((field) => [field, ""]));

/**
 * Confirms the course is one the caller can see.
 *
 * `assessments.course_id` is a plain foreign key, and the insert policy only
 * checks `user_id`. Without this, a posted `course_id` naming somebody else's
 * course would be accepted by the database. Reading it back through the
 * session-scoped client is the check: RLS makes another account's course
 * indistinguishable from a course that does not exist.
 */
async function ownsCourse(supabase: SupabaseServerClient, courseId: string): Promise<boolean> {
  const { data } = await supabase.from("courses").select("id").eq("id", courseId).maybeSingle();
  return data !== null;
}

function assessmentRow(input: ReturnType<typeof assessmentSchema.parse>) {
  return {
    title: input.title,
    kind: input.kind,
    weight_percent: input.weightPercent,
    due_hint: input.dueHint,
  };
}

export async function createAssessment(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const values = readFormValues(formData, ASSESSMENT_FIELDS);
  const courseId = rowIdSchema.safeParse(formData.get("courseId"));
  if (!courseId.success) return formError(NO_COURSE, values);

  const parsed = assessmentSchema.safeParse(values);
  if (!parsed.success) return toFormState(parsed.error, values);

  const supabase = await createClient();
  const userId = await requireUserId(supabase);

  if (!(await ownsCourse(supabase, courseId.data))) return formError(NO_COURSE, values);

  const { error } = await supabase.from("assessments").insert({
    ...assessmentRow(parsed.data),
    course_id: courseId.data,
    user_id: userId,
    // `source` and `confirmed` keep their defaults: hand-entered components are
    // 'manual' and born confirmed. The `confirmed = false` hard gate is
    // reserved for unreviewed LLM syllabus extractions, which are a later
    // milestone and must never be born active.
  });

  if (error) return formError(SAVE_FAILED, values);

  revalidatePath(`/courses/${courseId.data}`);
  revalidatePath("/courses");

  return { status: "success", message: `${parsed.data.title} added.`, values: CLEARED };
}

export async function updateAssessment(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const values = readFormValues(formData, ASSESSMENT_FIELDS);
  const id = rowIdSchema.safeParse(formData.get("assessmentId"));
  const courseId = rowIdSchema.safeParse(formData.get("courseId"));
  if (!id.success || !courseId.success) return formError(NOT_FOUND, values);

  // One form, two submitters: "Save" and "Delete" (see the `intent` convention).
  if (formData.get("intent") === "delete") {
    return deleteAssessment(id.data, courseId.data);
  }

  const parsed = assessmentSchema.safeParse(values);
  if (!parsed.success) return toFormState(parsed.error, values);

  const supabase = await createClient();
  await requireUserId(supabase);

  const { data, error } = await supabase
    .from("assessments")
    .update(assessmentRow(parsed.data))
    .eq("id", id.data)
    .select("id")
    .maybeSingle();

  if (error) return formError(SAVE_FAILED, values);
  if (!data) return formError(NOT_FOUND, values);

  revalidatePath(`/courses/${courseId.data}`);
  revalidatePath("/courses");

  return { status: "success", message: "Saved.", values };
}

/**
 * Module-private, and reached through `updateAssessment`'s `intent` — deleting
 * a component means opening its row first, which is the confirmation step.
 * Exporting it would also publish it as its own endpoint.
 */
async function deleteAssessment(id: string, courseId: string): Promise<FormState> {
  const supabase = await createClient();
  await requireUserId(supabase);

  const { data, error } = await supabase
    .from("assessments")
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error) return formError(SAVE_FAILED);
  if (!data) return formError(NOT_FOUND);

  revalidatePath(`/courses/${courseId}`);
  revalidatePath("/courses");

  return { status: "info", message: "Deleted." };
}
