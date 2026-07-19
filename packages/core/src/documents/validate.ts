/**
 * The `validate` step's decision, as a pure function.
 *
 * ## One function, two call sites, one message
 *
 * This module is deliberately the *only* place that decides whether an upload is
 * acceptable, and it runs in two places that must never disagree:
 *
 *   - **In the browser, before the TUS transfer starts.** Checking size here is
 *     what makes an oversized file cost the user nothing: 156 MB does not crawl
 *     up the wire only to be refused by Storage with an opaque error.
 *   - **In the `validate` Inngest step, on the bytes Storage actually holds.**
 *     This is the authoritative one. The browser check is a courtesy and is
 *     trivially bypassable — the row is not accepted because the client said so,
 *     it is accepted because the stored bytes passed.
 *
 * Because both call `validateDocument`, the sentence the user reads when they
 * are stopped early is *the same sentence* they would have read had they got all
 * the way to the pipeline. That is the property worth having: a validator with
 * two implementations grows two vocabularies, and then "why did it say something
 * different this time" becomes a real support question in a one-person app.
 *
 * ## Every rejection names the fix
 *
 * PLAN §7 asks for "user-readable reasons"; §2's DECIDED note of 2026-07-18 goes
 * further for the size case specifically — state the actual size, state the
 * limit, suggest compressing or splitting. Every message below follows that
 * shape: what we found, what is allowed, what to do. None of them contain a
 * code, a byte count, an exception, or the word "invalid".
 */

import {
  formatBytes,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_INFLATED_BYTES,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_LABEL,
} from "./limits";
import { looksEncrypted, looksLikePdf } from "./pdf";
import { readZipDirectory } from "./zip";

/** The formats the pipeline can actually read (PLAN §4.1 PDF, §4.2 PPTX). */
export type DocumentFormat = "pdf" | "pptx";

export const DOCUMENT_MIME_TYPES: Readonly<Record<DocumentFormat, string>> = {
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/**
 * Why an upload was refused. The code is for logs and tests; `message` is the
 * only thing a user ever sees, and it is built here rather than by the caller so
 * that no call site can degrade it into "Validation failed".
 */
export type RejectionCode =
  | "empty"
  | "too-large"
  | "unreadable-format"
  | "unsupported-format"
  | "encrypted-pdf"
  | "archive-too-large"
  | "archive-too-many-entries"
  | "damaged-archive";

export interface DocumentRejection {
  readonly code: RejectionCode;
  /** User-facing. States what was found, the limit, and the fix. Never a stack trace. */
  readonly message: string;
}

export interface AcceptedDocument {
  readonly format: DocumentFormat;
  readonly mimeType: string;
  readonly sizeBytes: number;
  /** Present for PPTX: what the archive declared. Useful in the processing feed. */
  readonly archive?: {
    readonly entryCount: number;
    readonly declaredInflatedBytes: number;
  };
}

export type DocumentValidation =
  | { readonly ok: true; readonly document: AcceptedDocument }
  | { readonly ok: false; readonly rejection: DocumentRejection };

function reject(code: RejectionCode, message: string): DocumentValidation {
  return { ok: false, rejection: { code, message } };
}

/**
 * The size check, split out because it is the only one that can run without the
 * bytes — which is exactly what the browser needs before deciding to upload.
 *
 * `filename` is quoted back so the message is unambiguous when several files are
 * queued at once.
 */
export function validateDocumentSize(input: {
  readonly sizeBytes: number;
  readonly filename: string;
}): DocumentValidation | null {
  const { sizeBytes, filename } = input;

  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return reject(
      "empty",
      `“${filename}” is empty. Check the file opens on your computer, then upload it again.`,
    );
  }

  if (sizeBytes > MAX_DOCUMENT_BYTES) {
    // The message PLAN §2 specifies, verbatim in shape: actual size, the limit,
    // the fix. No splitting and no re-compression happens anywhere in the
    // pipeline, so telling the user to do it is not passing the buck — it is the
    // whole decided behaviour.
    return reject(
      "too-large",
      `“${filename}” is ${formatBytes(sizeBytes)}. The limit is ${MAX_DOCUMENT_LABEL}. ` +
        `Compress it, or split it into parts under ${MAX_DOCUMENT_LABEL}, and upload again.`,
    );
  }

  return null;
}

/**
 * The full check, on real bytes.
 *
 * Order is deliberate and is the cheap-to-expensive one: size (arithmetic) →
 * format sniff (a few hundred bytes) → format-specific checks (a scan). A 156 MB
 * file is refused by the first branch without the sniff ever touching it.
 *
 * `declaredMimeType` is accepted but **never trusted** — it is a browser's guess
 * from the file extension. It is used only to improve the message when a file we
 * cannot read is nonetheless recognisable (a `.docx`, say), so the user is told
 * what to do rather than "unrecognised". The accept/reject decision comes from
 * the bytes.
 */
export function validateDocument(input: {
  readonly bytes: Uint8Array;
  readonly filename: string;
  /** The browser's guess. Advisory only. */
  readonly declaredMimeType?: string | undefined;
}): DocumentValidation {
  const { bytes, filename } = input;

  const sizeVerdict = validateDocumentSize({ sizeBytes: bytes.length, filename });
  if (sizeVerdict !== null) return sizeVerdict;

  // ── PDF ────────────────────────────────────────────────────────────────────
  if (looksLikePdf(bytes)) {
    if (looksEncrypted(bytes)) {
      return reject(
        "encrypted-pdf",
        `“${filename}” is password-protected, so its text can’t be read. ` +
          "Open it with the password, save or print an unprotected copy, and upload that.",
      );
    }
    return {
      ok: true,
      document: {
        format: "pdf",
        mimeType: DOCUMENT_MIME_TYPES.pdf,
        sizeBytes: bytes.length,
      },
    };
  }

  // ── OOXML (a ZIP) ──────────────────────────────────────────────────────────
  const zip = readZipDirectory(bytes);
  if (zip.ok) {
    const { entryCount, declaredInflatedBytes, ooxml } = zip.directory;

    // The bomb guard runs BEFORE the kind check, on purpose: an archive built to
    // exhaust memory should be refused whether or not it is pretending to be a
    // presentation, and neither branch below has decompressed anything yet.
    if (entryCount > MAX_ARCHIVE_ENTRIES) {
      return reject(
        "archive-too-many-entries",
        `“${filename}” contains ${entryCount.toLocaleString("en-US")} files, and the limit is ` +
          `${MAX_ARCHIVE_ENTRIES.toLocaleString("en-US")}. That is far more than a lecture deck ` +
          "normally holds — export it to PDF and upload that instead.",
      );
    }

    if (declaredInflatedBytes > MAX_ARCHIVE_INFLATED_BYTES) {
      return reject(
        "archive-too-large",
        `“${filename}” unpacks to ${formatBytes(declaredInflatedBytes)}, and the limit is ` +
          `${formatBytes(MAX_ARCHIVE_INFLATED_BYTES)}. It is probably packed with very large ` +
          "images or video — export it to PDF and upload that instead.",
      );
    }

    if (ooxml === "pptx") {
      return {
        ok: true,
        document: {
          format: "pptx",
          mimeType: DOCUMENT_MIME_TYPES.pptx,
          sizeBytes: bytes.length,
          archive: { entryCount, declaredInflatedBytes },
        },
      };
    }

    // A Word or Excel file, or a plain ZIP. Recognised well enough to say
    // something useful, which is the difference between a dead end and a next
    // step. Word specifically matters: the real syllabus corpus contains a
    // `.docx`, and "export as PDF" is a ten-second fix.
    if (ooxml === "docx") {
      return reject(
        "unsupported-format",
        `“${filename}” is a Word document, and only PDF and PowerPoint files can be read ` +
          "right now. Open it and export as PDF, then upload that.",
      );
    }
    if (ooxml === "xlsx") {
      return reject(
        "unsupported-format",
        `“${filename}” is an Excel spreadsheet, and only PDF and PowerPoint files can be read ` +
          "right now. Export the sheets you need as PDF and upload that.",
      );
    }

    return reject(
      "unsupported-format",
      `“${filename}” is a zip archive, not a document. Unzip it and upload the PDF or ` +
        "PowerPoint file inside.",
    );
  }

  // A ZIP that could not be walked. Told apart from "not a ZIP at all", because
  // a damaged upload and a wrong file type need different advice — and a
  // resumable transfer that was interrupted produces exactly the former.
  if (zip.reason !== "not-a-zip") {
    return reject(
      "damaged-archive",
      `“${filename}” looks like a PowerPoint file but is damaged, which usually means the ` +
        "upload was interrupted. Try uploading it again.",
    );
  }

  return reject(
    "unreadable-format",
    `“${filename}” isn’t a PDF or a PowerPoint file. Only those two can be read right now — ` +
      "if this is something else, export it as PDF and upload that.",
  );
}

/**
 * The pre-upload guess for the upload dialog's `kind` field (PLAN §8: "asks for
 * `kind` … pre-guessed from MIME type and filename").
 *
 * A guess, and presented as one — the dialog shows it selected and the user can
 * change it. Filename signals beat format signals because they are more
 * specific: a PDF named `syllabus.pdf` is a syllabus, while a PDF with no
 * signal in its name is most likely a reading.
 */
export type DocumentKind = "slides" | "reading" | "case" | "syllabus";

const KIND_HINTS: ReadonlyArray<readonly [DocumentKind, RegExp]> = [
  // Checked first: a syllabus is the one kind with a distinct downstream path
  // (assessment extraction), so a false negative costs more than for the others.
  ["syllabus", /\b(syllabus|syllabi|course[-_ ]?guide|loes|programme?[-_ ]?guide)\b/i],
  ["case", /\b(case|hbs|harvard|ivey)\b/i],
  ["slides", /\b(slides?|deck|lecture|session|week|unit|s\d{1,2}|l\d{1,2})\b/i],
  ["reading", /\b(reading|chapter|chp|article|paper|textbook|book)\b/i],
];

export function guessDocumentKind(input: {
  readonly filename: string;
  readonly format?: DocumentFormat | undefined;
}): DocumentKind {
  for (const [kind, pattern] of KIND_HINTS) {
    if (pattern.test(input.filename)) return kind;
  }
  // No signal in the name: a PowerPoint file is a deck almost by definition,
  // while a bare PDF is more often a reading than anything else.
  return input.format === "pptx" ? "slides" : "reading";
}
