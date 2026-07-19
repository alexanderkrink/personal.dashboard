/**
 * The completeness contracts (PLAN "Document & Notes Pipeline" §5 *Completeness & coverage*
 * and *Step D*).
 *
 * Two model contracts, both of which answer a question the pipeline cannot answer for
 * itself:
 * - {@link coverageChecklistSchema} — does the course's syllabus name anything that has no
 *   topic page? The *importance* oracle, as opposed to the page-count oracle that
 *   `computeCoverage` already provides deterministically.
 * - {@link deepReviewAuditSchema} — an independent second reader's list of what a student
 *   must know from this material, reconciled against the topics just built.
 *
 * ## Both schemas are FLAT, and that is not a style preference
 *
 * 🔴 Measured, Wave 4: a `TopicPage` carrying nested `{documentId, locator:{page, slide}}`
 * source objects was rejected by Anthropic with **HTTP 400 — "The compiled grammar is too
 * large"**, on every call, before a token was generated. `deep-review-audit` runs on
 * `claude-opus-4-8` and returns an array of findings, which is exactly the shape that blew
 * the grammar ceiling last time. So a finding carries a single `page: number` rather than an
 * array of source objects, and no field here is an array of objects nested inside another
 * array of objects. The cost is a slightly coarser citation; the alternative is a call that
 * cannot be made at all.
 *
 * Per `./index.ts`: `.describe()` on every field, because the descriptions are the prompt
 * surface that actually steers these calls.
 */

import { z } from "zod";

/* ────────────────────────────────────────────────────────────────────────── */
/* The syllabus checklist                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * How completely the course's topic set covers one syllabus objective.
 *
 * Three values rather than a boolean, because the two-valued version forces a bad answer on
 * the most common real case: a topic that covers half of "explain and compute price
 * elasticity". Calling that `covered` hides a real gap; calling it `missing` cries wolf
 * about a page that plainly exists. `partial` is the answer that produces a useful
 * `openQuestion` on a page that a student can act on.
 */
export const OBJECTIVE_COVERAGE = ["full", "partial", "none"] as const;

export const objectiveCoverageSchema = z.object({
  objective: z
    .string()
    .describe(
      "The learning objective, in the syllabus's own words. Copy it rather than paraphrasing — a student compares this against their syllabus.",
    ),
  coverage: z
    .enum(OBJECTIVE_COVERAGE)
    .describe(
      "'full' when a topic page teaches this objective completely; 'partial' when a page covers part of it but a student following only these notes would still be short; 'none' when no page addresses it at all.",
    ),
  topicId: z
    .string()
    .nullable()
    .describe(
      "The id of the covering topic, copied EXACTLY from the topic index you were given. null when coverage is 'none'. Never invent an id — an id that is not in the index is discarded.",
    ),
  detail: z
    .string()
    .describe(
      "For 'partial', what specifically is still missing — this becomes an open question on that topic page, so write it so a student can act on it. For 'full', one short phrase naming where it is taught. For 'none', what a page on this would need to contain.",
    ),
});

export const coverageChecklistSchema = z.object({
  objectives: z
    .array(objectiveCoverageSchema)
    .describe(
      "Every learning objective the syllabus states, in the order it states them. Extract the objectives from the syllabus text yourself — do not invent objectives the document does not state, and do not skip one because it looks obviously covered.",
    ),
  notes: z
    .string()
    .nullable()
    .describe(
      "Anything a student should know that the per-objective rows cannot hold — for instance that the syllabus states no learning objectives at all. null when there is nothing to add.",
    ),
});

export type ObjectiveCoverage = z.infer<typeof objectiveCoverageSchema>;
export type CoverageChecklist = z.infer<typeof coverageChecklistSchema>;

/* ────────────────────────────────────────────────────────────────────────── */
/* Step D — the deep-review audit                                             */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * What the audit concluded about one concept, and therefore what happens to it.
 *
 * The four values map one-to-one onto PLAN's risk split, and the mapping is the whole
 * design of Step D:
 *
 * | verdict | what the pipeline does | risk |
 * | --- | --- | --- |
 * | `missing` | creates a topic | additive, revertible |
 * | `refine` | appends a block, as a tracked revision | visible, revertible |
 * | `conflict` | records an `openQuestion`, changes nothing | **never overwrites** |
 * | `covered` | nothing | none |
 *
 * `conflict` is the one that earns the design. A second reader that disagrees with the page
 * is *sometimes the one that is wrong*, and a pipeline that let the audit overwrite on
 * disagreement would silently replace correct notes with a confident second opinion. So a
 * contradiction is surfaced to the student with both sides, exactly as Step B does.
 */
export const AUDIT_VERDICTS = ["missing", "refine", "conflict", "covered"] as const;

export const auditFindingSchema = z.object({
  concept: z
    .string()
    .describe(
      "The concept a student must know from this material, named as a concept — 'Price Elasticity of Demand', never 'Session 7 notes'.",
    ),
  verdict: z
    .enum(AUDIT_VERDICTS)
    .describe(
      "'covered' when the existing pages teach this well — this is the COMMON and correct answer for most concepts. 'refine' when a page covers it but is missing something specific the material contains. 'conflict' when a page states something this material contradicts. 'missing' when no page addresses it at all.",
    ),
  topicId: z
    .string()
    .nullable()
    .describe(
      "The id of the relevant existing topic, copied EXACTLY from the topic index. Required for 'refine', 'conflict' and 'covered'. null for 'missing'. An id not in the index is discarded.",
    ),
  detail: z
    .string()
    .describe(
      "What is missing, wrong or contradicted, specifically and in one or two sentences. For 'conflict', say what the page claims AND what this material says — both halves, because the student decides which is right.",
    ),
  evidence: z
    .string()
    .describe(
      "A short VERBATIM quote from the material supporting this finding. A finding without a quote is an opinion, and it will be shown to a student next to your claim.",
    ),
  page: z
    .number()
    .int()
    .describe(
      "The 1-based page or slide of the material your evidence is on. Use 0 only if it genuinely spans the whole document.",
    ),
  markdown: z
    .string()
    .nullable()
    .describe(
      "For 'missing' and 'refine': the study material to add, as markdown a student reads — real notes, not a description of what notes would say. null for 'conflict' and 'covered', which add no content.",
    ),
});

export const deepReviewAuditSchema = z.object({
  concepts: z
    .array(auditFindingSchema)
    .describe(
      "Every concept a student must know from this material, with your verdict on each. Work from the MATERIAL first and consult the topic index second — listing what is there and then checking the pages, not reading the pages and looking for holes.",
    ),
  summary: z
    .string()
    .describe(
      "Two or three sentences a student reads on the status card: what this second reading found overall. Concrete counts beat adjectives.",
    ),
});

export type AuditFinding = z.infer<typeof auditFindingSchema>;
export type DeepReviewAudit = z.infer<typeof deepReviewAuditSchema>;
