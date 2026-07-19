"use server";

import { AI_PAUSED_USER_MESSAGE, AIPausedError } from "@study/ai";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AINotConfiguredError } from "@/lib/ai/runtime";
import { requireUserId } from "@/lib/auth/require-user";
import { type FormState, formError, toFormState } from "@/lib/forms/form-state";
import { createClient } from "@/lib/supabase/server";
import { runSyllabusExtraction } from "@/lib/syllabus/extract";

/**
 * The mandatory confirm gate for syllabus-extracted grade weights (§2b).
 *
 * Two outcomes, no third. There is deliberately no "confirm just this one row" —
 * the proposal is reviewed as a unit because the weights only make sense
 * together (they are meant to sum), and a half-confirmed syllabus produces a
 * grade projection built from numbers the user never actually agreed to.
 * Editing an individual weight is what the existing per-row editor is for,
 * after confirmation.
 *
 * Both actions are thin: the real work is one atomic RPC each, because
 * confirming touches the assessments rows, `courses.total_sessions` and the run
 * itself, and a partial result is worse than a failure. See
 * `20260719122153_confirm_syllabus_extraction.sql`.
 */

const extractionIdSchema = z.uuid();

const CONFIRM_FAILED = "That didn’t save. The proposal is untouched — try again.";
const REJECT_FAILED = "That didn’t discard. The proposal is still here — try again.";
const NOT_FOUND = "That proposal no longer exists. It may have been resolved in another tab.";

async function resolve(
  formData: FormData,
  rpc: "confirm_syllabus_extraction" | "reject_syllabus_extraction",
  failureMessage: string,
): Promise<FormState> {
  const extractionId = extractionIdSchema.safeParse(formData.get("extractionId"));
  const courseId = z.uuid().safeParse(formData.get("courseId"));
  if (!extractionId.success || !courseId.success) return formError(NOT_FOUND);

  const supabase = await createClient();
  // Not used for authorization — RLS owns that, and the RPCs are `security
  // invoker` so another account's extraction is invisible rather than forbidden.
  // This is here so an expired session redirects to /login instead of failing as
  // a confusing not-found.
  await requireUserId(supabase);

  const { error } = await supabase.rpc(rpc, { p_extraction_id: extractionId.data });
  if (error) return formError(failureMessage);

  revalidatePath(`/courses/${courseId.data}`);
  return { status: "success" };
}

export async function confirmSyllabusExtraction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  return resolve(formData, "confirm_syllabus_extraction", CONFIRM_FAILED);
}

export async function rejectSyllabusExtraction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  return resolve(formData, "reject_syllabus_extraction", REJECT_FAILED);
}

/**
 * Runs the `syllabus-components` job over pasted syllabus text.
 *
 * **Text, not a file.** Upload, storage and PDF/DOCX conversion are item 5 (Wave 4);
 * this is the interim path, and a deliberately useful one — "select all in the PDF,
 * paste" costs the user ten seconds and needs no pipeline. When item 5 lands it feeds
 * the same `runSyllabusExtraction` and this form can stay or go.
 *
 * Everything it produces is unconfirmed. There is no route from here to an active
 * grade weight that does not pass through the confirm gate (§2b).
 */
const extractSchema = z.object({
  sourceLabel: z
    .string()
    .trim()
    .min(1, "Give this document a name so you can recognise it later.")
    .max(200, "That name is too long."),
  documentText: z
    .string()
    .trim()
    // A syllabus that fits in a tweet is a paste that went wrong — almost always the
    // header only, which §5.1b records as producing confident nonsense.
    .min(400, "That looks too short to be a whole syllabus. Paste the entire document.")
    .max(400_000, "That document is too long to process in one go."),
});

const EXTRACT_FIELDS = ["sourceLabel", "documentText"] as const;

/** Blank strings for every field — what a successful extraction echoes back. */
const CLEARED = Object.fromEntries(EXTRACT_FIELDS.map((field) => [field, ""]));

export async function extractSyllabus(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const values = Object.fromEntries(
    EXTRACT_FIELDS.map((field) => [field, String(formData.get(field) ?? "")]),
  );
  const courseId = z.uuid().safeParse(formData.get("courseId"));
  if (!courseId.success) return formError("That course no longer exists.", values);

  const parsed = extractSchema.safeParse(values);
  // The document text is echoed back on failure so a long paste survives a bad label —
  // WCAG 2.2 SC 3.3.7, and retyping a 40 000-character paste is not a thing to ask.
  if (!parsed.success) return toFormState(parsed.error, values);

  const supabase = await createClient();
  const userId = await requireUserId(supabase);

  const { data: course } = await supabase
    .from("courses")
    .select("id, title")
    .eq("id", courseId.data)
    .maybeSingle();
  if (!course) return formError("That course no longer exists.", values);

  try {
    const outcome = await runSyllabusExtraction({
      supabase,
      userId,
      courseId: course.id,
      courseTitle: course.title,
      sourceLabel: parsed.data.sourceLabel,
      documentText: parsed.data.documentText,
    });

    if (outcome.status === "unreadable") {
      return formError(
        "The model couldn’t make sense of that document. Nothing was saved — the attempt is still logged against your AI spend.",
        values,
      );
    }

    revalidatePath(`/courses/${course.id}`);
    // Echo blank fields so the paste does not linger. `FormField` holds its value in
    // client state, so without this the whole syllabus stays in the textarea after a
    // successful run — and the proposal the user now needs to read is pushed below tens
    // of thousands of characters they have already finished with.
    return { status: "success", values: CLEARED };
  } catch (error) {
    // §6's two "not now / not configured" states, told apart so the message is true.
    if (error instanceof AIPausedError) return formError(AI_PAUSED_USER_MESSAGE, values);
    if (error instanceof AINotConfiguredError) {
      return formError("AI isn’t configured on this deployment.", values);
    }
    throw error;
  }
}
