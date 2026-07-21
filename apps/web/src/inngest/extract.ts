/**
 * The `extract` step's body (PLAN "Document & Notes Pipeline" §4.1/§4.2, M1 item 5c).
 *
 * This is the first LLM call any Inngest function in this repo makes. Wave 3 built the
 * whole `packages/ai` stack — job registry, prompt templates, schemas, the §2 failure
 * ladder, the §3 stamp, metering and the §6 guard — and nothing in a background job used
 * it. This module is where that changes, and it goes through `createAIRuntime` rather than
 * around it: **no `@ai-sdk/*` import, no model ID, and no `UNMETERED_ACKNOWLEDGEMENT`.**
 * The extraction call is the most expensive one in the product, so an unmetered version of
 * it would be the largest possible hole in the budget guard.
 *
 * ## Three routes, two fidelities
 *
 * | Source | Route | `extraction_fidelity` |
 * | --- | --- | --- |
 * | native PDF | `pdf-native` | `visual` |
 * | PPTX ≥ 40 words/slide | `pptx-xml` | `text-only` |
 * | PPTX < 40 words/slide | `pptx-converted-pdf` | `visual` |
 *
 * The fidelity is written from the route that actually ran, on every path, and is never
 * defaulted — `documents.extraction_fidelity` is nullable in the schema, and a null there
 * must mean "not extracted yet", never "extracted, forgot to say how".
 *
 * ## Re-running this step is safe
 *
 * Gate 1's F4 notes that `document_chunks` has no unique key, which constrains
 * re-processing design downstream. This step has the opposite property and keeps it
 * deliberately: it **replaces** `documents.extraction` with a complete object rather than
 * merging into or appending to it, so attempt 4 of a flaky run leaves exactly what attempt
 * 1 would have. Nothing here accumulates. The only rows it appends are progress-feed
 * lines, which are an append-only narration by design and whose duplication is cosmetic.
 *
 * Retries do cost money — a transport failure after a successful `generateObject` re-runs
 * the call — but that is metered, visible in `ai_generations`, and capped by §6, which is
 * the correct place for it to be handled rather than with a bespoke cache here.
 */

import {
  type DocumentExtraction,
  type ExtractionRoute,
  fidelityForRoute,
  type StoredExtraction,
  structurePdf,
  structureSlideText,
} from "@study/ai";
import {
  countPdfPages,
  extractPptx,
  isVisualDeck,
  type PptxExtraction,
  PptxExtractionError,
  VISUAL_DECK_WORDS_PER_SLIDE,
} from "@study/core";
import type { SupabaseAdminClient } from "@study/db";
import { NonRetriableError } from "inngest";
import { env } from "@/env";
import {
  DocumentRejectedError,
  downloadViaSignedUrl,
  logProcessingEvent,
  setDocumentStatus,
} from "@/inngest/documents";
import { createStudyAIRuntime } from "@/lib/ai/runtime";
import { CloudConvertError, convertPptxToPdf } from "@/lib/documents/cloudconvert";

export interface ExtractInput {
  readonly admin: SupabaseAdminClient;
  readonly userId: string;
  readonly documentId: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly filename: string;
  readonly storagePath: string;
  /** The sniffed format from `validate` — the bytes' verdict, never the client's claim. */
  readonly format: "pdf" | "pptx";
}

/**
 * What the step hands back to the pipeline.
 *
 * Deliberately small. The extraction itself can be hundreds of kilobytes on a 45-slide
 * deck, and an Inngest step's return value is serialized into the run's own state — so the
 * big artifact goes to Postgres, where the next step reads it from, and this carries only
 * what the run needs to make decisions and what the report needs to show.
 */
export interface ExtractSummary {
  readonly route: ExtractionRoute;
  readonly fidelity: "text-only" | "visual";
  readonly sourceUnits: number;
  readonly wordsPerSlide: number | null;
  readonly pagesExtracted: number;
  readonly pagesSkipped: number;
  readonly examSignals: number;
  readonly sessionLabel: string | null;
  readonly costUsd: number | null;
  readonly elapsedMs: number;
}

export async function runExtract(input: ExtractInput): Promise<ExtractSummary> {
  const { admin, userId, documentId, courseId, courseTitle, filename, storagePath, format } = input;
  const startedAt = Date.now();

  await setDocumentStatus(admin, documentId, userId, { status: "extracting" });
  await logProcessingEvent(admin, {
    userId,
    documentId,
    courseId,
    step: "extract",
    detail: `Reading ${filename}.`,
  });

  const runtime = createStudyAIRuntime({ userId });
  const bytes = await downloadViaSignedUrl(admin, storagePath);

  /** Writes the human reason to the row, then throws — the `documents.ts` contract. */
  const rejectWith = async (code: string, message: string): Promise<never> => {
    await setDocumentStatus(admin, documentId, userId, {
      status: "failed",
      failureReason: message,
    });
    await logProcessingEvent(admin, {
      userId,
      documentId,
      courseId,
      step: "extract",
      level: "error",
      detail: message,
    });
    throw new DocumentRejectedError(documentId, code, message);
  };

  // ── Decide the route, and get to a PDF or to slide markdown ─────────────────
  let route: ExtractionRoute;
  let sourceUnits: number;
  let wordsPerSlide: number | null = null;
  let pdfBytes: Uint8Array | null = null;
  let parsed: PptxExtraction | null = null;

  if (format === "pdf") {
    route = "pdf-native";
    pdfBytes = bytes;
    sourceUnits = countPdfPages(bytes) ?? 0;
  } else {
    try {
      parsed = await extractPptx(bytes);
    } catch (error) {
      if (error instanceof PptxExtractionError) {
        return await rejectWith(error.reason, error.message);
      }
      throw error;
    }
    sourceUnits = parsed.slideCount;
    wordsPerSlide = parsed.wordsPerSlide;

    if (isVisualDeck(parsed)) {
      // ── The visual path (§4.2). For a course like Marketing this IS the path. ──
      if (env.CLOUDCONVERT_API_KEY === undefined) {
        // Refuse rather than quietly falling back to the text branch. A silent
        // downgrade here produces exactly the "mostly-empty topic pages" outcome the
        // measured-corpus block exists to prevent, and produces it invisibly.
        return await rejectWith(
          "conversion-unavailable",
          `“${filename}” is a picture-heavy deck (${parsed.wordsPerSlide.toFixed(0)} words per slide), so its content is in the images and it needs to be converted before it can be read properly. That converter isn’t configured right now.`,
        );
      }

      await logProcessingEvent(admin, {
        userId,
        documentId,
        courseId,
        step: "extract",
        detail: `Only ${parsed.wordsPerSlide.toFixed(0)} words per slide — the content is in the images. Converting to PDF so it can be read visually.`,
      });

      try {
        const converted = await convertPptxToPdf({
          apiKey: env.CLOUDCONVERT_API_KEY,
          pptxBytes: bytes,
          filename,
        });
        pdfBytes = converted.pdfBytes;
      } catch (error) {
        if (error instanceof CloudConvertError && !error.retriable) {
          return await rejectWith(
            "conversion-failed",
            `“${filename}” couldn’t be converted for visual reading. The file may use features the converter doesn’t support.`,
          );
        }
        throw error;
      }

      route = "pptx-converted-pdf";
      // The converted PDF's own page count is the authority from here on: a converter
      // can legitimately drop a hidden slide or split one across pages, and citing
      // slide numbers against a document the model never saw would mis-cite every page.
      sourceUnits = countPdfPages(pdfBytes) ?? parsed.slideCount;
    } else {
      route = "pptx-xml";
    }
  }

  // ── The one `generateObject` call ───────────────────────────────────────────
  const result =
    pdfBytes !== null
      ? await structurePdf({
          runtime,
          pdfBytes,
          filename,
          courseTitle,
          ...(sourceUnits > 0 ? { pageCount: sourceUnits } : {}),
        })
      : await structureSlideText({
          runtime,
          // `parsed` is non-null on this branch: it is the only way `pdfBytes` stays null.
          slideMarkdown: parsed?.markdown ?? "",
          slideCount: parsed?.slideCount ?? 0,
          filename,
          courseTitle,
        });

  if (result.status === "dead-letter") {
    // §2's dead-letter is an outcome, not an exception — but for this step it IS terminal
    // for the document, and non-retriable: the ladder already spent a corrective retry and
    // a cross-family escalation, so Inngest retrying the whole step buys three more
    // identical failures at full price.
    const message =
      result.reason === "refusal"
        ? `The reader declined to process “${filename}”. If it contains unusual material, try uploading a different version.`
        : `“${filename}” couldn’t be read into study notes. This is usually a problem on our side — try again, and if it keeps failing let the file sit and come back to it.`;
    await setDocumentStatus(admin, documentId, userId, {
      status: "failed",
      failureReason: message,
    });
    await logProcessingEvent(admin, {
      userId,
      documentId,
      courseId,
      step: "extract",
      level: "error",
      detail: message,
    });
    throw new NonRetriableError(
      `Extraction dead-lettered for ${documentId} (${result.reason}): ${result.message}`,
    );
  }

  const extraction: DocumentExtraction = result.value;

  // ── Persist. A full replace, which is what makes a re-run idempotent. ───────
  const stored: StoredExtraction = {
    route,
    fidelity: fidelityForRoute(route),
    sourceUnits,
    wordsPerSlide,
    extraction,
  };

  const { error } = await admin
    .from("documents")
    .update({
      extraction: stored,
      extraction_fidelity: stored.fidelity,
      // The document's own label wins over the one the uploader typed, but only when the
      // document actually printed one — `sessionLabel` is nullable precisely so the model
      // can decline, and overwriting a human's "Session 1" with a null would be a loss.
      ...(extraction.sessionLabel === null ? {} : { session_label: extraction.sessionLabel }),
    })
    .eq("id", documentId)
    .eq("user_id", userId);

  if (error) {
    throw new Error(`Could not store the extraction for ${documentId}: ${error.message}`);
  }

  // ── What THIS run's extraction cost, from the metering rows the runtime just wrote (§7).
  // Bounded to this run's start (`startedAt`) so a retry or reprocess of the same document —
  // identical bytes and prompt, hence the identical input_hash — cannot bill this line for
  // an earlier run's attempts.
  const costUsd = await extractionCost(admin, userId, result.stamp.inputHash, startedAt);

  const skippedPages = extraction.skipped.reduce(
    (total, range) => total + Math.max(0, range.toPage - range.fromPage + 1),
    0,
  );

  await logProcessingEvent(admin, {
    userId,
    documentId,
    courseId,
    step: "extract",
    detail: `Read ${extraction.pages.length} of ${sourceUnits > 0 ? sourceUnits : extraction.pages.length} pages${
      skippedPages === 0
        ? ""
        : `, skipping ${skippedPages} (${extraction.skipped.map((range) => range.reason).join("; ")})`
    }.${extraction.examSignals.length === 0 ? "" : ` Found ${extraction.examSignals.length} exam hint${extraction.examSignals.length === 1 ? "" : "s"}.`}${
      costUsd === null ? "" : ` Cost $${costUsd.toFixed(4)}.`
    }`,
  });

  return {
    route,
    fidelity: stored.fidelity,
    sourceUnits,
    wordsPerSlide,
    pagesExtracted: extraction.pages.length,
    pagesSkipped: skippedPages,
    examSignals: extraction.examSignals.length,
    sessionLabel: extraction.sessionLabel,
    costUsd,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Sums what THIS run's extraction cost, across every ladder rung.
 *
 * Read back from `ai_generations` rather than tracked in-process because that is the row
 * §6 bills against — if the two ever disagree, the table is right and the in-memory number
 * is a story.
 *
 * ⚠ Scoped by `input_hash` AND by `created_at >= runStartedAt`. `input_hash` alone is the
 * wrong scope: it is deterministic in (prompt, version, content), so a step retry (the
 * module docstring above: "a transport failure after a successful `generateObject` re-runs
 * the call") or a reprocess re-issues the identical extraction and writes FRESH rows under
 * the SAME hash. Summing by hash alone bills this line for every run the document has ever
 * had — the whole document's history, not this run's extract step. That contradicts what the
 * feed line claims to show, and the number silently doubles on the first retry. The run's own
 * start time is the bound that fixes it: every rung of this attempt is logged after it and
 * every earlier run's rows before it — the same time-bounding `mergeCost` uses, here made
 * exact because the extract step is a single hash rather than a spray of them.
 *
 * ⚠ Clock boundary: `runStartedAt` is the app/process clock (`Date.now()`), while `created_at`
 * is the DB clock (`now()`). If the DB clock lags the app clock by MORE than the gap between
 * capturing `startedAt` and the row insert, this run's own earliest rows could fall below the
 * bound and be excluded — under-counting the line. In practice the extract call spends minutes
 * between the two, an enormous margin against sub-second NTP skew, so this is a theoretical edge,
 * not a live risk; an exact fix would need a `run_id`/`document_id` on `ai_generations` (there is
 * none today) rather than a time heuristic.
 *
 * Returns `null` when nothing could be read or every row is unpriced; the caller renders
 * it as "no cost shown" rather than as "$0.00", because a free call and an unmeasured one
 * are very different things to see on a budget page.
 */
export async function extractionCost(
  admin: SupabaseAdminClient,
  userId: string,
  inputHash: string,
  runStartedAt: number,
): Promise<number | null> {
  const { data, error } = await admin
    .from("ai_generations")
    .select("cost_usd")
    .eq("user_id", userId)
    .eq("input_hash", inputHash)
    .gte("created_at", new Date(runStartedAt).toISOString());

  if (error || data === null || data.length === 0) return null;

  const priced = data.filter((row): row is { cost_usd: number } => row.cost_usd !== null);
  if (priced.length === 0) return null;
  return priced.reduce((total, row) => total + row.cost_usd, 0);
}

/** Re-exported so the step and its tests share one threshold. */
export { VISUAL_DECK_WORDS_PER_SLIDE };
