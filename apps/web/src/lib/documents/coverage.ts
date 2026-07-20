import { z } from "zod";

/**
 * `documents.coverage`, as §8's terminal card and the topic page both read it.
 *
 * Every field is defaulted and the whole object is nullable, because the column is null for
 * every document processed before the coverage step existed and for every document whose
 * coverage step failed. A card must render those as "no coverage line" rather than as zeros,
 * which would claim a measurement that was never taken.
 *
 * Lives in its own module because it has two consumers that must not drift: the documents
 * feed (a client hook) and the topic page (a server component). A second copy of this shape
 * would be a second opinion about what `pagesUnmapped` means, and Wave 5 already spent a
 * correction on exactly that confusion — `pagesUnmapped`, `pagesSkipped` and
 * `pagesUndeclared` are three different facts and the UI counts each as itself.
 */
export const coverageSchema = z.object({
  checked: z.boolean().default(false),
  pagesTotal: z.number().default(0),
  pagesMapped: z.number().default(0),
  pagesSkipped: z.number().default(0),
  pagesUndeclared: z.number().default(0),
  pagesUnmapped: z.number().default(0),
  topicCount: z.number().default(0),
  trustworthy: z.boolean().default(false),
  gaps: z
    .array(
      z.object({
        fromPage: z.number(),
        toPage: z.number(),
        kind: z.string(),
        reason: z.string(),
      }),
    )
    .default([]),
  warnings: z.array(z.string()).default([]),
  missingObjectives: z.array(z.string()).default([]),
});

export type DocumentCoverage = z.infer<typeof coverageSchema>;
export type CoverageGapRow = DocumentCoverage["gaps"][number];

/**
 * "p. 4" for a single page, "pp. 4–9" for a range. Shared by every gap list.
 *
 * Takes only the two page fields rather than a whole {@link CoverageGapRow}, so a caller
 * that has already narrowed a gap list by `kind` can pass its narrowed rows without
 * re-widening them.
 */
export function gapLabel(gap: Pick<CoverageGapRow, "fromPage" | "toPage">): string {
  return gap.fromPage === gap.toPage ? `p. ${gap.fromPage}` : `pp. ${gap.fromPage}–${gap.toPage}`;
}
