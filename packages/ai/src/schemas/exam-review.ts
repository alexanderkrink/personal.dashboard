/**
 * The exam-review contract (PLAN §9 *"Generation … Output schema"*).
 *
 * One Opus call per course produces this: prioritized topic sections (depth proportional to
 * exam weight), a consolidated formula sheet, a likely-exam-questions bank with answers, and a
 * weak-spots list. Every item carries `topicIds` so the reading UI can link each piece back to
 * the topic pages it came from (§9: "Every item carries topic ids for click-through").
 *
 * ## 🔴 This schema is FLAT, and that is a hard constraint, not a preference
 *
 * Measured, Wave 4 (recorded on `coverage.ts` and PLAN §2): a schema with an array of objects
 * nested inside another array of objects was rejected by Anthropic with **HTTP 400 — "The
 * compiled grammar is too large"**, on every call, before a token was generated. `exam-review`
 * runs on `claude-opus-4-8` and returns four top-level arrays, which is exactly the shape that
 * blew the grammar ceiling last time.
 *
 * So the rule this file obeys: **no field is an array of objects nested inside another array of
 * objects.** A `TopicSection`'s notes, formulas, worked example and pitfalls are single
 * markdown *strings*, not arrays of block objects; `topicIds` is an array of *strings*, not of
 * objects. The consolidated formula sheet and the question bank are top-level arrays of flat
 * objects whose every field is a string, an enum or a `string[]`. The cost is a coarser
 * structure the UI re-inflates from markdown; the alternative is a call that cannot be made.
 *
 * Per `./index.ts`: `.describe()` on every field — the descriptions are the prompt surface
 * that steers the call, not documentation. And per the same file: `.min(1)` is client-side
 * validation that trips the §2 failure ladder, never a generation-time guarantee.
 */

import { z } from "zod";

/** A section's depth, which the prompt ties to the topic's exam weight. */
export const EXAM_SECTION_DEPTH = ["deep", "standard", "brief"] as const;

/** A question's kind, so the UI can group the bank and the student knows what to expect. */
export const EXAM_QUESTION_KINDS = ["conceptual", "numeric", "applied"] as const;

/**
 * One prioritized topic section. Depth is proportional to exam weight: a `deep` section gets
 * condensed notes, its formulas, one worked example and its pitfalls; a `brief` one gets two or
 * three lines in `notes` and leaves the rest empty.
 *
 * All content fields are markdown strings (KaTeX `$…$` is rendered by the reading UI). No field
 * is an array of objects — that is the grammar-ceiling rule above.
 */
export const examTopicSectionSchema = z.object({
  topicIds: z
    .array(z.string())
    .describe(
      "The id(s) of the topic(s) this section covers, copied EXACTLY from the topic index you were given — usually one. This is the click-through target, so an id not in the index is useless. Never invent one.",
    ),
  title: z.string().describe("The topic's title, for the section heading."),
  depth: z
    .enum(EXAM_SECTION_DEPTH)
    .describe(
      "'deep' for the highest-weight topics (full condensed notes, formulas, a worked example, pitfalls); 'standard' for mid-weight; 'brief' for low-weight topics — two or three lines in `notes` and the other fields left empty. Match this to the exam weight shown in the index.",
    ),
  notes: z
    .string()
    .describe(
      "Condensed revision notes for this topic as markdown — the depth set above. For a 'brief' topic, just two or three lines. Inline math in `$…$`.",
    ),
  formulas: z
    .string()
    .describe(
      "The formulas a student must know for this topic, as a markdown list with each formula in `$$…$$` display math and one line on what it computes. Empty string when the topic has none.",
    ),
  workedExample: z
    .string()
    .nullable()
    .describe(
      "ONE worked example for a 'deep' section, as markdown showing the method and keeping the numbers. null for 'standard'/'brief' sections and for topics with no example worth the space.",
    ),
  pitfalls: z
    .string()
    .describe(
      "The common mistakes and misreadings for this topic, as a short markdown list — the things that lose marks. Empty string when there is nothing specific to warn about.",
    ),
});

/** One entry on the consolidated formula sheet. A flat object; `latex` carries no `$`. */
export const examFormulaEntrySchema = z.object({
  topicIds: z
    .array(z.string())
    .describe("The topic id(s) this formula belongs to, copied exactly from the index."),
  name: z.string().describe("What the formula is called."),
  latex: z
    .string()
    .describe("The formula as LaTeX, WITHOUT surrounding $ delimiters — the sheet adds them."),
  meaning: z
    .string()
    .describe("One line: what it computes and what the symbols stand for in this course."),
});

/** One likely exam question with its answer. A flat object. */
export const examQuestionSchema = z.object({
  topicIds: z
    .array(z.string())
    .describe("The topic id(s) this question tests, copied exactly from the index."),
  kind: z
    .enum(EXAM_QUESTION_KINDS)
    .describe("'conceptual' to explain/define, 'numeric' to compute, 'applied' to use in a case."),
  question: z.string().describe("The question, phrased the way this course's exam would."),
  answer: z
    .string()
    .describe(
      "A model answer as markdown: enough that a student can mark their own attempt, with the working for a numeric one.",
    ),
});

/** One weak spot — built from the topics' open questions and conflicts. A flat object. */
export const examWeakSpotSchema = z.object({
  topicIds: z
    .array(z.string())
    .describe("The topic id(s) this weak spot concerns, copied exactly from the index."),
  issue: z
    .string()
    .describe(
      "What is shaky or unresolved — an open question, a conflict between sessions, a gap the material never closed.",
    ),
  suggestion: z
    .string()
    .describe("What the student should do about it before the exam, concretely."),
});

export const examReviewSchema = z.object({
  overview: z
    .string()
    .describe(
      "Two or three sentences orienting the student: what this exam covers and where the weight sits. The first thing they read.",
    ),
  sections: z
    .array(examTopicSectionSchema)
    .describe(
      "One section per topic worth revising, ORDERED by exam weight, highest first. Depth proportional to weight — do not give a low-weight topic a deep section, and do not skip a high-weight one.",
    ),
  formulaSheet: z
    .array(examFormulaEntrySchema)
    .describe(
      "Every formula across all topics, consolidated into one sheet for last-minute review. Empty array for a course with no formulas.",
    ),
  questionBank: z
    .array(examQuestionSchema)
    .describe(
      "Likely exam questions with answers, weighted toward the high-weight topics. Cover the range of kinds the exam format calls for.",
    ),
  weakSpots: z
    .array(examWeakSpotSchema)
    .describe(
      "The topics' unresolved open questions and cross-session conflicts, each with what to do about it. Empty array when nothing is flagged — do not manufacture weak spots.",
    ),
});

export type ExamTopicSection = z.infer<typeof examTopicSectionSchema>;
export type ExamFormulaEntry = z.infer<typeof examFormulaEntrySchema>;
export type ExamQuestion = z.infer<typeof examQuestionSchema>;
export type ExamWeakSpot = z.infer<typeof examWeakSpotSchema>;
export type ExamReview = z.infer<typeof examReviewSchema>;
