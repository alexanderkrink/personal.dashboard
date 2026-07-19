/**
 * Syllabus prompt templates (PLAN.md §AI Strategy §3).
 *
 * `syllabus-components` — the first production prompt in this repo, and the first real
 * consumer of the whole `packages/ai` stack.
 *
 * ## Why this takes document TEXT, not a PDF
 *
 * The wave brief described syllabi as "PDFs that go straight to Gemini vision", which would
 * have meant re-pointing the job off its pinned `claude-sonnet-5`. It does not, and the
 * reason is worth recording so nobody re-litigates it from the brief alone:
 *
 * - `generateStructured` renders a prompt to a **string**. There is no multimodal path
 *   through the metered runtime at all, so "send the PDF to a vision model" is not a
 *   one-line `JOBS` edit — it is a new capability in the call wrapper, and every call made
 *   through it would have to be metered afresh.
 * - Once the document is text, nothing in this task is multimodal. It is long-context
 *   reading comprehension over prose and a table, which is what `claude-sonnet-5` is pinned
 *   for in §1b.
 * - Text-in also makes the one `.docx` fixture a first-class input rather than a special
 *   case, which is the only way all three real syllabi share a code path without wiring
 *   CloudConvert (item 5, Wave 4).
 *
 * So the job stays on its pinned model and `JOBS` is untouched. `doc-structuring`
 * (`gemini-3.1-pro-preview`) remains the multimodal job; if a scanned, image-only syllabus
 * ever turns up, THAT is the job that should read it, handing text to this one.
 *
 * ## Why the rules live mostly in the schema
 *
 * `schemas/syllabus.ts` carries the extraction rules on the fields they govern, because a
 * `.describe()` reaches the model attached to the exact key it constrains. This template
 * carries only what is about the document as a whole: read all of it, quote don't
 * paraphrase, and say "I don't know" in the shape of a null.
 */

import { definePrompt } from "./define";

/**
 * The one instruction that has cost real accuracy when omitted.
 *
 * PLAN.md §5.1b: LOES puts its entire evaluation table at paragraph ~293 of 420, and an
 * earlier hand-transcription that read only the header concluded the document had no
 * session data — the opposite of the truth. A header-only read does not fail loudly; it
 * produces confident nonsense.
 */
const READ_THE_WHOLE_BODY =
  "The evaluation table is usually NOT near the top. In real IE syllabi it sits roughly two thirds of the way through the document, long after the description, objectives and bibliography. Read the entire text before answering.";

export const syllabusComponentsPrompt = definePrompt({
  id: "syllabus-components",
  version: 1,
  description:
    "Extracts a course's graded components (title, kind, weight, session number) and its total session count from the full text of a syllabus, with a verbatim source snippet per component for the mandatory human confirm gate.",
  render: ({ courseTitle, documentText }: { courseTitle: string; documentText: string }) =>
    [
      "You are reading a university course syllabus and extracting its grading scheme.",
      "",
      `The person reading this expects it to describe the course "${courseTitle}", but the document is the authority — if it names a different course, report the name it actually prints and extract what is in front of you anyway. A mismatch is shown to a human; a quietly corrected title is not.`,
      "",
      READ_THE_WHOLE_BODY,
      "",
      "Rules:",
      "- Quote, do not paraphrase. Every snippet you return must appear verbatim in the text below. A human checks your weights against your snippets, so an invented snippet is worse than no answer.",
      "- Extract the ORDINARY evaluation scheme. Syllabi often also state a re-take, second-call or third-attempt scheme with different weights. Those apply only to a student who already failed. Never mix them in, and mention in `notes` if you found and excluded one.",
      "- Prefer null to a guess. A null session number costs a human ten seconds; a wrong one silently moves an exam date on their dashboard.",
      "- Do not make the weights add to 100. Report what the document says. Real syllabi legitimately do not sum — extra credit, 'best 3 of 4', a rounded lecturer. If they do not sum, say so in `notes` and leave the numbers alone.",
      "",
      "SYLLABUS TEXT:",
      "---",
      documentText,
      "---",
    ].join("\n"),
});

/**
 * The system prompt for `syllabus-components`.
 *
 * Separate from the template because `generateStructured` takes `system` separately, and
 * because it is stable across every version of the user-facing template.
 */
export const SYLLABUS_COMPONENTS_SYSTEM =
  "You extract grading schemes from university syllabi. You are precise, you quote rather than summarise, and you answer null rather than guessing. The weights you extract feed a student's grade projections, so a confident wrong number is far more damaging than an admitted gap.";
