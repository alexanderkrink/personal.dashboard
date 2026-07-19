/**
 * The `doc-structuring` job (PLAN "Document & Notes Pipeline" §4.1/§4.2, M1 item 5c).
 *
 * A document → structured study material, in **one** `generateObject` call, through the
 * metered runtime. Two entry points because §4 has two branches, but one schema and one
 * job, so `documents.extraction` has the same shape whichever ran.
 *
 * Like `syllabus-components`, this module deliberately knows nothing about where the bytes
 * came from and touches no database. Storage, CloudConvert and the `documents` row are the
 * Inngest step's business; this is the binding of prompt to schema to model, and it exists
 * so no call site has to know which goes with which.
 *
 * Metering, the §3 stamp and the §2 ladder all come from `generateStructured` and cannot
 * be bypassed here — in particular the PDF branch goes through the runtime's `files`
 * channel rather than reaching for `unmeteredLanguageModel`, because the extraction call
 * is the most expensive one in the product and an unmetered one would be the largest
 * possible hole in the §6 budget guard.
 */

import {
  DOC_STRUCTURING_SYSTEM,
  docStructuringPrompt,
  docStructuringSlideTextPrompt,
} from "../prompts/documents";
import type { AIRuntime, GenerateStructuredResult } from "../runtime";
import { type DocumentExtraction, documentExtractionSchema } from "../schemas/documents";

/** Media type for every PDF that reaches the file branch. */
export const PDF_MEDIA_TYPE = "application/pdf";

export interface StructurePdfOptions {
  readonly runtime: AIRuntime;
  /** The PDF itself. Native upload, or the CloudConvert output for a visual deck. */
  readonly pdfBytes: Uint8Array;
  /** Shown to the model, and used as the `file` part's filename. */
  readonly filename: string;
  /** The course the human filed this under. The document may disagree; the document wins. */
  readonly courseTitle: string;
  /** Page count, when the caller knows it. Helps the model check its own coverage. */
  readonly pageCount?: number;
}

/**
 * §4.1: signed URL → bytes → a `file` part → one `generateObject` on `doc-structuring`.
 *
 * Background rather than interactive: nobody is blocked on this in a modal — the upload
 * returns immediately and the status card narrates. Under §6 budget pressure this is the
 * work that should defer first, which is exactly the tradeoff `kind` encodes.
 */
export function structurePdf({
  runtime,
  pdfBytes,
  filename,
  courseTitle,
  pageCount,
}: StructurePdfOptions): Promise<GenerateStructuredResult<DocumentExtraction>> {
  return runtime.generateStructured({
    prompt: docStructuringPrompt,
    vars: {
      courseTitle,
      filename,
      pageHint:
        pageCount === undefined
          ? ""
          : ` It has ${pageCount} ${pageCount === 1 ? "page" : "pages"}, so your "pages" and "skipped" arrays together must account for pages 1 to ${pageCount}.`,
    },
    schema: documentExtractionSchema,
    system: DOC_STRUCTURING_SYSTEM,
    files: [{ data: pdfBytes, mediaType: PDF_MEDIA_TYPE, filename }],
    kind: "background",
  });
}

export interface StructureSlideTextOptions {
  readonly runtime: AIRuntime;
  /** Per-slide markdown from `extractPptx` — shape text, tables and speaker notes. */
  readonly slideMarkdown: string;
  readonly slideCount: number;
  readonly filename: string;
  readonly courseTitle: string;
}

/**
 * §4.2 v1: the PPTX text path.
 *
 * Takes markdown rather than the `.pptx` because neither provider reads PPTX natively and
 * `packages/core` has already done the parsing — including resolving speaker notes through
 * the per-slide relationship parts, which is the part naive converters get wrong.
 */
export function structureSlideText({
  runtime,
  slideMarkdown,
  slideCount,
  filename,
  courseTitle,
}: StructureSlideTextOptions): Promise<GenerateStructuredResult<DocumentExtraction>> {
  return runtime.generateStructured({
    prompt: docStructuringSlideTextPrompt,
    vars: { courseTitle, filename, slideCount, slideMarkdown },
    schema: documentExtractionSchema,
    system: DOC_STRUCTURING_SYSTEM,
    // `doc-structuring-slide-text` resolves to `doc-structuring` through the variant-suffix
    // rule, so this is not strictly required — it is written out because a silent
    // dependence on suffix-stripping for the *model* choice is worth making explicit.
    job: "doc-structuring",
    kind: "background",
  });
}
