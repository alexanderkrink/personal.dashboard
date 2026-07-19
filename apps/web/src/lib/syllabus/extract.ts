/**
 * Running the `syllabus-components` job and landing its proposal (M1 item 11).
 *
 * The seam is deliberate: this module takes **document text**, never a file. Turning a
 * PDF or a .docx into text is item 5's job (Wave 4's document pipeline) and is not built
 * here — the fixture validation for this wave converted the three real syllabi with a
 * throwaway harness outside the repo. When item 5 lands, it hands its extracted text to
 * this function and nothing here changes.
 *
 * Everything this writes is a *proposal*. Grade weights are one of exactly two data
 * classes behind a mandatory human confirm (§2b), so:
 * - the `assessments` rows land `confirmed = false` (enforced by a database trigger, not
 *   by this code — see `20260719121909_apply_syllabus_extraction.sql`);
 * - the proposed `courses.total_sessions` is **not** written to `courses` at all. It waits
 *   on the extraction row until a human confirms, because §5.1b reads that column to pick
 *   an exam date and dates are the other reserved confirm class.
 */

import type { SyllabusComponents } from "@study/ai";
import { extractSyllabusComponents } from "@study/ai";
import type { Database, SupabaseServerClient } from "@study/db";
import { createStudyAIRuntime } from "@/lib/ai/runtime";

/**
 * The generated argument type for `apply_syllabus_extraction`, with the three genuinely
 * nullable parameters restored.
 *
 * Supabase's type generator reads a function's *signature*, and a PL/pgSQL signature
 * cannot express that `p_notes text` accepts NULL — so it types every parameter as
 * non-nullable. All three of these are nullable by design, and one load-bearingly so:
 * `p_proposed_total_sessions` must be able to say "this document declares no session
 * count", which is the honest answer for a syllabus with no header field and no
 * `SESSION n` headings.
 *
 * This widens the generated type back to what the function actually accepts. It does not
 * loosen a check — the database's own constraints are unchanged and still authoritative.
 */
type ApplyExtractionArgs = Omit<
  Database["public"]["Functions"]["apply_syllabus_extraction"]["Args"],
  "p_notes" | "p_proposed_total_sessions" | "p_total_sessions_evidence"
> & {
  p_notes: string | null;
  p_proposed_total_sessions: number | null;
  p_total_sessions_evidence: string | null;
};

export interface RunSyllabusExtractionOptions {
  readonly supabase: SupabaseServerClient;
  readonly userId: string;
  readonly courseId: string;
  readonly courseTitle: string;
  /** How the document identified itself — a file name today, a `documents` row later. */
  readonly sourceLabel: string;
  /** The WHOLE document body. A header-only read produces confident nonsense (§5.1b). */
  readonly documentText: string;
}

export type SyllabusExtractionOutcome =
  | {
      readonly status: "extracted";
      readonly extractionId: string;
      readonly value: SyllabusComponents;
      /** True when the document names a different course than the one it was attached to. */
      readonly titleMismatch: boolean;
    }
  | { readonly status: "unreadable"; readonly message: string };

/** Case- and whitespace-insensitive, because a syllabus title is typed by a human. */
function sameCourse(a: string, b: string): boolean {
  const normalise = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
  return normalise(a) === normalise(b);
}

export async function runSyllabusExtraction({
  supabase,
  userId,
  courseId,
  courseTitle,
  sourceLabel,
  documentText,
}: RunSyllabusExtractionOptions): Promise<SyllabusExtractionOutcome> {
  const runtime = createStudyAIRuntime({ userId });

  const result = await extractSyllabusComponents({ runtime, documentText, courseTitle });

  // A syllabus the model cannot parse is a normal outcome the UI renders, not a throw.
  // The attempts that got us here are already in `ai_generations` either way — the
  // runtime meters each rung as it completes, including the ones that failed.
  if (result.status === "dead-letter") {
    return { status: "unreadable", message: result.message };
  }

  const { value, stamp } = result;

  // One statement, one transaction. See the migration for why a partial landing is the
  // specific state the confirm gate exists to prevent.
  const args: ApplyExtractionArgs = {
    p_user_id: userId,
    p_course_id: courseId,
    p_source_label: sourceLabel,
    p_extracted_course_title: value.courseTitle,
    p_proposed_total_sessions: value.totalSessions,
    p_total_sessions_evidence: value.totalSessionsEvidence,
    p_notes: value.notes,
    p_prompt_id: stamp.promptId,
    p_prompt_version: stamp.promptVersion,
    p_provider: stamp.provider,
    p_model: stamp.model,
    p_input_hash: stamp.inputHash,
    p_components: value.components.map((component) => ({
      title: component.title,
      kind: component.kind,
      weight_percent: component.weightPercent,
      session_number: component.sessionNumber,
      source_snippet: component.sourceSnippet,
      session_note: component.sessionNote,
    })),
  };

  const { data, error } = await supabase.rpc(
    "apply_syllabus_extraction",
    args as Database["public"]["Functions"]["apply_syllabus_extraction"]["Args"],
  );

  if (error || typeof data !== "string") {
    throw new Error(
      `Could not save the syllabus extraction: ${error?.message ?? "no id returned"}`,
    );
  }

  return {
    status: "extracted",
    extractionId: data,
    value,
    titleMismatch: !sameCourse(value.courseTitle, courseTitle),
  };
}
