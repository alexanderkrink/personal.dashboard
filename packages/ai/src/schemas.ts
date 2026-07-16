import { z } from "zod";

/**
 * Structured-output schemas shared between prompts and callers.
 * Every LLM call that produces data (not prose) must go through a Zod
 * schema via the AI SDK's structured output support.
 *
 * Example schema establishing the pattern; real schemas arrive with M1.
 */
export const documentSummarySchema = z.object({
  title: z.string().min(1).describe("Short human-readable title for the document"),
  summary: z.string().min(1).describe("2-3 sentence summary of the document"),
  keyTerms: z
    .array(z.object({ term: z.string(), definition: z.string() }))
    .describe("Important terms defined in the document"),
});

export type DocumentSummary = z.infer<typeof documentSummarySchema>;
