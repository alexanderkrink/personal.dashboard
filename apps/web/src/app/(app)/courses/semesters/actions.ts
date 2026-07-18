"use server";

import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth/require-user";
import { rowIdSchema, SEMESTER_FIELDS, semesterSchema } from "@/lib/courses/schemas";
import { type FormState, formError, toFormState } from "@/lib/forms/form-state";
import { readFormValues } from "@/lib/forms/form-values";
import { createClient } from "@/lib/supabase/server";

/**
 * Semester writes.
 *
 * These stay on one page rather than redirecting: a term is three fields, and
 * the list it lands in is right there. Success therefore returns a `FormState`
 * with blank `values`, which is what clears the form — `FormField` re-seeds
 * from `state.values`, so echoing empties is the reset.
 */

const SAVE_FAILED = "That didn’t save. Try again — nothing you typed was lost.";
const NOT_FOUND = "That semester no longer exists. It may have been deleted in another tab.";

/** Blank strings for every field — what a successful create echoes back. */
const CLEARED = Object.fromEntries(SEMESTER_FIELDS.map((field) => [field, ""]));

function semesterRow(input: ReturnType<typeof semesterSchema.parse>) {
  return { name: input.name, starts_on: input.startsOn, ends_on: input.endsOn };
}

export async function createSemester(_previous: FormState, formData: FormData): Promise<FormState> {
  const values = readFormValues(formData, SEMESTER_FIELDS);
  const parsed = semesterSchema.safeParse(values);
  if (!parsed.success) return toFormState(parsed.error, values);

  const supabase = await createClient();
  const userId = await requireUserId(supabase);

  const { error } = await supabase
    .from("semesters")
    .insert({ ...semesterRow(parsed.data), user_id: userId });

  if (error) return formError(SAVE_FAILED, values);

  revalidatePath("/courses/semesters");
  revalidatePath("/courses");

  return {
    status: "success",
    message: `${parsed.data.name} added.`,
    values: CLEARED,
  };
}

export async function updateSemester(_previous: FormState, formData: FormData): Promise<FormState> {
  const values = readFormValues(formData, SEMESTER_FIELDS);
  const id = rowIdSchema.safeParse(formData.get("semesterId"));
  if (!id.success) return formError(NOT_FOUND, values);

  // One form, two submitters: "Save" and "Delete" (the `intent` convention).
  if (formData.get("intent") === "delete") return deleteSemester(id.data);

  const parsed = semesterSchema.safeParse(values);
  if (!parsed.success) return toFormState(parsed.error, values);

  const supabase = await createClient();
  await requireUserId(supabase);

  const { data, error } = await supabase
    .from("semesters")
    .update(semesterRow(parsed.data))
    .eq("id", id.data)
    .select("id")
    .maybeSingle();

  if (error) return formError(SAVE_FAILED, values);
  if (!data) return formError(NOT_FOUND, values);

  revalidatePath("/courses/semesters");
  revalidatePath("/courses");

  return { status: "success", message: "Saved.", values };
}

/**
 * Deletes a semester.
 *
 * Safe in a way archiving a course is not: `courses.semester_id` is
 * `on delete set null`, so the courses survive and simply stop belonging to a
 * term. Having to open the row first is the confirmation step.
 *
 * Module-private, and reached through `updateSemester`'s `intent`: every export
 * of a `"use server"` module is a callable endpoint, and this one has no reason
 * to be a second one.
 */
async function deleteSemester(id: string): Promise<FormState> {
  const supabase = await createClient();
  await requireUserId(supabase);

  const { data, error } = await supabase
    .from("semesters")
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error) return formError(SAVE_FAILED);
  if (!data) return formError(NOT_FOUND);

  revalidatePath("/courses/semesters");
  revalidatePath("/courses");

  return { status: "info", message: "Deleted. Any courses on that term kept their place." };
}
