/**
 * Syllabus extraction schemas (PLAN.md §Grade & Semester Cockpit, §5.1b).
 *
 * One structured contract, two consumers:
 * - **the Grade Cockpit** takes `components[]` and proposes `assessments` rows
 *   (`title`, `kind`, `weight_percent`, `session_number`), all born `confirmed = false`;
 * - **the §5.1b exam chain** takes `totalSessions` and writes `courses.total_sessions`
 *   with `total_sessions_source = 'syllabus'`, which is what finally makes the step-1
 *   oracle distinguishable from the `max(sessionTo)` fallback instead of circular with it.
 *
 * `.describe()` on every field is deliberate: per `schemas/index.ts` the descriptions ARE
 * the prompt surface. Most of the extraction rules below live in a `.describe()` rather
 * than in the prompt template, because the model sees them attached to the exact field
 * they govern.
 *
 * Two traps, both taken from the real documents and both encoded here rather than left to
 * the prompt's prose (see PLAN.md §5.1b's transcription block):
 * 1. **The re-take scheme is not the course's weights.** *Applied Business Mathematics*
 *    states an ordinary call (Final 40 / Midterm 20 / Individual work 20 / Participation 20)
 *    AND a third-attempt scheme (Deliverables 20 / Midterm 35 / Final 45). Extracting the
 *    second silently corrupts every grade projection for a student who never re-sat.
 * 2. **Session ranges do not fit `session_number`.** LOES grades its group presentation over
 *    `SESSIONS 28/29`. `assessments.session_number` is a single `int`, so a range must
 *    resolve to `null` plus a stated `sessionNote` — never to a silently-picked endpoint.
 */

import { z } from "zod";

/**
 * The six values `assessments.kind` permits (migration `20260717161053_…`).
 *
 * Mirrored here rather than imported because `packages/ai` must not depend on
 * `packages/db`. Nothing inside this package can assert the two lists still agree, so
 * `apps/web` — which can see both — owns that check at the insert site.
 *
 * ⚠ `kind` cannot distinguish a final from a midterm — both are `'exam'`. That is a
 * recorded finding (PLAN.md §5.1b, ⚠ CORRECTED 2026-07-18): the discriminator is `title`.
 * Which is exactly why `title` below is required to be the document's own wording.
 */
export const ASSESSMENT_KINDS = [
  "exam",
  "quiz",
  "project",
  "participation",
  "paper",
  "other",
] as const;

export const assessmentKindSchema = z
  .enum(ASSESSMENT_KINDS)
  .describe(
    "The component's type. 'exam' covers every sit-down or timed assessment INCLUDING midterms and finals — do not try to encode which one it is here, that lives in the title. 'quiz' is short repeated tests (multiple-choice quizzes, intermediate tests). 'project' is group or individual work products including presentations. 'participation' is a class-participation or engagement grade. 'paper' is a written essay or report. 'other' is anything that fits none of these, such as peer evaluation.",
  );

export const syllabusComponentSchema = z.object({
  title: z
    .string()
    .min(1)
    .describe(
      "The component's name EXACTLY as the syllabus writes it — 'Final Exam', 'In class Midterm Exam', 'Class Participation', 'Group Research Presentation'. Do not normalise, translate, expand or tidy it. This string is the only thing downstream can use to tell a final from a midterm, because both are stored with kind='exam'.",
    ),
  kind: assessmentKindSchema,
  // Range-checked client-side on purpose. `assessments.weight_percent` carries
  // `check (weight_percent >= 0 and weight_percent <= 100)`, so an out-of-range value
  // would otherwise sail through the schema and die at the insert — after the call was
  // paid for, and as a 500 rather than a retry. Validating here routes it into the §2
  // corrective retry instead, which is the machinery that exists for exactly this.
  weightPercent: z
    .number()
    .min(0)
    .max(100)
    .describe(
      "The percentage of the final course grade this component is worth, as a number between 0 and 100. Take the ORDINARY (first-call) evaluation scheme. If the syllabus also states a re-take, second-call or third-attempt scheme with different weights, IGNORE it entirely — those weights apply only to a student who failed, and recording them corrupts the grade projection for everyone else. If a component is stated as a total split into parts ('Intermediate tests 15% (3 x 5%)'), record the TOTAL (15), not the part.",
    ),
  sessionNumber: z
    .number()
    .int()
    .nullable()
    .describe(
      "The session number this component happens on, when — and only when — the syllabus states it, e.g. 'SESSION 30 (LIVE IN-PERSON) Final Exam' gives 30. Use null when the syllabus does not say. Use null ALSO when the syllabus gives a RANGE such as 'SESSIONS 28/29' or 'SESSION 28 & 29': a range does not fit a single session number, so record null here and state the range in sessionNote. Never guess a session number from position in the schedule.",
    ),
  sessionNote: z
    .string()
    .nullable()
    .describe(
      "Free text for session timing that sessionNumber cannot hold — a range ('sessions 28/29'), or a vague placement the syllabus states ('week 9', 'final week'). Null when sessionNumber already says it or the syllabus says nothing.",
    ),
  sourceSnippet: z
    .string()
    .min(1)
    .describe(
      "A SHORT VERBATIM QUOTE from the document that establishes this component and its weight — normally the evaluation-table row it came from. Copy the document's own characters; do not paraphrase, summarise or reconstruct. A human reads this side-by-side with the extracted weight to confirm or reject it, so a snippet that does not literally appear in the document defeats the entire review step. Keep it under about 200 characters.",
    ),
});

export type SyllabusComponent = z.infer<typeof syllabusComponentSchema>;

export const syllabusComponentsSchema = z.object({
  courseTitle: z
    .string()
    .min(1)
    .describe(
      "The course title exactly as printed in the syllabus. Used to check the document against the course it is being attached to — a mismatch is surfaced to the human, so report what the document says even when it looks wrong.",
    ),
  totalSessions: z
    .number()
    .int()
    .nullable()
    .describe(
      "The total number of teaching sessions the course runs. Prefer an explicit header field ('NUMBER OF SESSIONS: 30'). If there is no such field, use the HIGHEST 'SESSION n' heading anywhere in the programme body — note that combined headings ('SESSION 28 & 29') mean the count of headings is LOWER than the highest number, so count the number, not the headings. Null only if the document genuinely establishes neither.",
    ),
  totalSessionsEvidence: z
    .string()
    .nullable()
    .describe(
      "A short verbatim quote showing where totalSessions came from — either the header field or the highest SESSION heading. Null when totalSessions is null.",
    ),
  components: z
    .array(syllabusComponentSchema)
    .describe(
      "Every graded component in the course's ordinary evaluation scheme, in the order the syllabus lists them. The evaluation table is frequently NOT near the top of the document — in real syllabi it sits two thirds of the way down — so read the whole body before answering. Include participation when it is graded. Do NOT include attendance if the syllabus says attendance does not affect the grade: attendance and participation are separate things and some syllabi grade one while explicitly not grading the other.",
    ),
  notes: z
    .string()
    .nullable()
    .describe(
      "Anything a human confirming these weights should know that the fields above cannot hold — a pass gate ('must score at least 4.0 on the final regardless of average'), weights that do not sum to 100, or a re-take scheme that was deliberately excluded. Null if there is nothing to flag.",
    ),
});

export type SyllabusComponents = z.infer<typeof syllabusComponentsSchema>;
