/**
 * The document-extraction contract (PLAN "Document & Notes Pipeline" §4.1/§4.2).
 *
 * One schema serves **both** branches of `extract`, and that is a deliberate design
 * decision rather than a convenience:
 *
 * - the **PDF path** sends the file itself to `gemini-3.1-pro-preview` and the model reads
 *   pages the way a student does — diagrams, equations rendered as images, scanned slides;
 * - the **PPTX text path** sends per-slide markdown that `packages/core` parsed out of the
 *   zip, and the model structures it.
 *
 * Because the output shape is identical, everything downstream — routing, merging,
 * chunking, coverage — is written once against one type and never learns which branch
 * produced its input. `documents.extraction_fidelity` is where the difference is recorded,
 * for the UI, and it is set by the *step*, never inferred from this object.
 *
 * Per the registry rules in `./index.ts`: flat-ish, non-recursive, and every field
 * `.describe()`d — descriptions here are prompt surface, and on a 40-page deck they are
 * doing more steering work than the template is.
 */

import { z } from "zod";

/**
 * "Page" means the natural unit of the source: a PDF page, or a PPTX slide.
 *
 * One vocabulary for both branches so the merge step never has to ask which it is holding.
 * 1-based, because that is what a person reading the file sees and what an `examSignals`
 * citation has to match to be checkable.
 */
export const extractedPageSchema = z.object({
  page: z
    .number()
    .int()
    .min(1)
    .describe("1-based page (PDF) or slide (PPTX) number, as printed or as ordered."),
  title: z
    .string()
    .nullable()
    .describe("The page's own heading, verbatim. null when the page carries no heading."),
  markdown: z
    .string()
    .describe(
      "The full content of this page as clean markdown: prose, bullets, tables as markdown tables, equations as inline LaTeX ($…$). Describe a diagram or chart in a sentence rather than omitting it — a described figure is recoverable, a dropped one is not. Do not summarise; this text is what gets chunked and searched.",
    ),
});

export const extractedHeadingSchema = z.object({
  text: z.string().describe("The heading, verbatim."),
  level: z.number().int().min(1).max(6).describe("1 for the top level, deeper numbers below."),
  page: z.number().int().min(1).describe("Page/slide the heading appears on."),
});

export const extractedDefinitionSchema = z.object({
  term: z.string().describe("The term being defined."),
  definition: z.string().describe("Its definition, in the document's own words where possible."),
  page: z.number().int().min(1),
});

export const extractedFormulaSchema = z.object({
  latex: z.string().describe("The formula as LaTeX, without surrounding $ delimiters."),
  meaning: z
    .string()
    .describe("One sentence: what it computes and what the symbols stand for in this course."),
  page: z.number().int().min(1),
});

export const extractedExampleSchema = z.object({
  title: z.string().describe("Short label for the worked example or case."),
  summary: z
    .string()
    .describe("What is being worked through and the method used. Keep the numbers if it has any."),
  page: z.number().int().min(1),
});

/**
 * An explicit "this will be on the exam" marker (§4.1, feeds `topics.exam_weight`).
 *
 * `quote` is required and must be verbatim: exam weight materially reorders a student's
 * revision plan, so the evidence has to be checkable against the page. A paraphrase is not
 * evidence — it is the model's opinion wearing evidence's clothes.
 */
export const examSignalSchema = z.object({
  quote: z
    .string()
    .describe(
      "The lecturer's words, VERBATIM — e.g. 'this will be on the exam', 'key formula', 'you must know this'. Never paraphrase; a human checks this against the page.",
    ),
  page: z.number().int().min(1).describe("Page/slide the quote appears on. Required."),
  topic: z
    .string()
    .describe("What the signal is about, in a few words — the concept it points at."),
});

/**
 * Deliberately-dropped material (§4.1, feeds `documents.coverage` and §8's status UI).
 *
 * **This is the completeness ledger, and an empty array is a claim, not a default.** The
 * whole reason the field exists is that a model asked to extract a 40-page deck will
 * quietly skip the title slide, the agenda, the bibliography and the "any questions?" page
 * — all reasonable — and the difference between a reasonable omission and a silent loss is
 * only ever whether it was *declared*. A run that returns `skipped: []` for a document it
 * actually abridged has converted reviewable choices back into invisible ones.
 */
export const skippedRangeSchema = z.object({
  fromPage: z.number().int().min(1).describe("First page/slide of the skipped run, inclusive."),
  toPage: z
    .number()
    .int()
    .min(1)
    .describe("Last page/slide of the skipped run, inclusive. Same as fromPage for one page."),
  reason: z
    .string()
    .describe(
      "Why it was dropped, concretely — 'title slide', 'agenda', 'bibliography', 'thank-you slide', 'duplicate of page 12'. A human reads this to decide whether to disagree.",
    ),
});

export const documentExtractionSchema = z.object({
  sessionLabel: z
    .string()
    .nullable()
    .describe(
      "The session/lecture this document belongs to, as the document itself labels it — 'Session 1', 'Lecture 7', 'Unit 3'. null if it does not say. Do not invent one from the filename.",
    ),
  summary: z
    .string()
    .describe(
      "Two or three sentences: what this document covers, for someone choosing what to revise.",
    ),
  pages: z
    .array(extractedPageSchema)
    .describe(
      "Every page/slide you did NOT list in `skipped`, in order. Together, `pages` and `skipped` must account for the whole document.",
    ),
  headings: z.array(extractedHeadingSchema).describe("The document's structure, in order."),
  definitions: z
    .array(extractedDefinitionSchema)
    .describe("Terms the document explicitly defines. Empty array if it defines none."),
  formulas: z
    .array(extractedFormulaSchema)
    .describe("Formulas and equations, as LaTeX. Empty array if there are none."),
  workedExamples: z
    .array(extractedExampleSchema)
    .describe("Worked examples, cases and exercises. Empty array if there are none."),
  examSignals: z
    .array(examSignalSchema)
    .describe(
      "Explicit exam/assessment hints, each with the page it is on. Only real signals — an empty array is the correct and common answer. Do not manufacture one from a slide merely looking important.",
    ),
  skipped: z
    .array(skippedRangeSchema)
    .describe(
      "Every page/slide you deliberately left out of `pages`, with a reason. Return [] ONLY if you genuinely extracted every page. If you dropped a title slide, an agenda, a bibliography or a thank-you page, it belongs here — silently omitting it is the one failure this field exists to prevent.",
    ),
});

export type ExtractedPage = z.infer<typeof extractedPageSchema>;
export type ExtractedHeading = z.infer<typeof extractedHeadingSchema>;
export type ExtractedDefinition = z.infer<typeof extractedDefinitionSchema>;
export type ExtractedFormula = z.infer<typeof extractedFormulaSchema>;
export type ExtractedExample = z.infer<typeof extractedExampleSchema>;
export type ExamSignal = z.infer<typeof examSignalSchema>;
export type SkippedRange = z.infer<typeof skippedRangeSchema>;
export type DocumentExtraction = z.infer<typeof documentExtractionSchema>;

/** `'text-only' | 'visual'` — `documents.extraction_fidelity`. Set by the step, never defaulted. */
export const EXTRACTION_FIDELITIES = ["text-only", "visual"] as const;
export const extractionFidelitySchema = z.enum(EXTRACTION_FIDELITIES);
export type ExtractionFidelity = z.infer<typeof extractionFidelitySchema>;

/**
 * How the extraction was actually obtained.
 *
 * Persisted alongside the extraction because `extraction_fidelity` alone cannot answer the
 * user's actual question. "Visual" is true of both a native PDF and a converted deck, but
 * only one of them went through a third-party converter — and when a converted deck reads
 * oddly, that is the first thing worth knowing.
 */
export const EXTRACTION_ROUTES = ["pdf-native", "pptx-xml", "pptx-converted-pdf"] as const;
export const extractionRouteSchema = z.enum(EXTRACTION_ROUTES);
export type ExtractionRoute = z.infer<typeof extractionRouteSchema>;

/**
 * The route → fidelity mapping (§4.1/§4.2), as a total function.
 *
 * A function rather than an inline ternary at the write site, for one reason: `switch` over
 * a union with no `default` is exhaustive, so **adding a fourth route to `EXTRACTION_ROUTES`
 * without deciding its fidelity is a type error.** The alternative —
 * `route === "pptx-xml" ? "text-only" : "visual"` — silently classifies every future route
 * as `visual`, and the failure mode is a document that claims its diagrams were read when
 * they were not. That is precisely the claim `extraction_fidelity` exists to make
 * trustworthy, so the compiler gets to enforce it.
 */
export function fidelityForRoute(route: ExtractionRoute): ExtractionFidelity {
  switch (route) {
    // The deck's own XML: real text, but the images were never looked at.
    case "pptx-xml":
      return "text-only";
    // Both of these put actual pages in front of a multimodal model.
    case "pdf-native":
    case "pptx-converted-pdf":
      return "visual";
  }
}

/**
 * What lands in `documents.extraction` — the model's output plus how it was obtained.
 *
 * Parsed on the way back OUT of the database as well as in: per `./index.ts`'s boundary
 * rule, a stored artifact is an external input to every future version of this code.
 */
export const storedExtractionSchema = z.object({
  route: extractionRouteSchema,
  fidelity: extractionFidelitySchema,
  /** Pages (PDF) or slides (PPTX) the source actually had, counted before the model saw it. */
  sourceUnits: z.number().int().min(0),
  /** §4.2 routing statistic. Present only on the two PPTX routes. */
  wordsPerSlide: z.number().nullable(),
  extraction: documentExtractionSchema,
});

export type StoredExtraction = z.infer<typeof storedExtractionSchema>;
