/**
 * The `syllabus-components` job (PLAN.md M1 item 11, §Grade & Semester Cockpit).
 *
 * Syllabus text → the graded components of the course, plus its declared session count.
 *
 * This is a thin binding of one prompt to one schema to one system message, and it exists
 * so that no call site has to know which of the three goes with which. It deliberately does
 * NOT know where the text came from: `apps/web` reads fixture files today, and the Wave 4
 * document pipeline (item 5) will hand it extracted text tomorrow, and neither is this
 * module's business.
 *
 * It also deliberately does NOT touch the database. Everything it returns is a *proposal*:
 * grade weights are one of exactly two data classes behind a mandatory human confirm
 * (§2b), so the decision to persist — and to persist `confirmed = false` — belongs to the
 * app, not to the package that talks to the model.
 *
 * Metering, the §3 stamp and the §2 failure ladder all come from `generateStructured`; this
 * module adds nothing to them and cannot bypass them.
 */

import { SYLLABUS_COMPONENTS_SYSTEM, syllabusComponentsPrompt } from "../prompts/syllabus";
import type { AIRuntime, GenerateStructuredResult } from "../runtime";
import { type SyllabusComponents, syllabusComponentsSchema } from "../schemas/syllabus";

export interface ExtractSyllabusComponentsOptions {
  readonly runtime: AIRuntime;
  /**
   * The full text of the syllabus. **The whole body**, not the header block — PLAN.md §5.1b
   * records that a header-only read of the LOES syllabus concluded it had no session data
   * when in fact it labels its exam sessions inline at paragraph ~293 of 420.
   */
  readonly documentText: string;
  /** The course the human is attaching this document to. The document may disagree. */
  readonly courseTitle: string;
}

/**
 * Runs the extraction.
 *
 * Returns the ladder's own result type rather than throwing on a dead-letter: a syllabus the
 * model cannot parse is a normal outcome the UI has to render ("we couldn't read this one"),
 * not an exception. Transport errors still throw, so the Inngest retry policy keeps owning
 * backoff (§6).
 */
export function extractSyllabusComponents({
  runtime,
  documentText,
  courseTitle,
}: ExtractSyllabusComponentsOptions): Promise<GenerateStructuredResult<SyllabusComponents>> {
  return runtime.generateStructured({
    prompt: syllabusComponentsPrompt,
    vars: { courseTitle, documentText },
    schema: syllabusComponentsSchema,
    system: SYLLABUS_COMPONENTS_SYSTEM,
    // A human is sitting on the confirm screen waiting for this. Under budget pressure §6
    // defers background work first and interactive work last, and this is the latter.
    kind: "interactive",
  });
}
