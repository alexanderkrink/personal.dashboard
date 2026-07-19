import { MAX_DOCUMENT_BYTES, validateDocument, validateDocumentSize } from "@study/core";
import { NonRetriableError } from "inngest";
import { inngest } from "@/inngest/client";
import {
  adminClient,
  DocumentCourseMismatchError,
  DocumentRejectedError,
  downloadDocumentBytes,
  logProcessingEvent,
  setDocumentStatus,
} from "@/inngest/documents";
import { documentUploaded, documentUploadedData } from "@/inngest/events";
import { runExtract } from "@/inngest/extract";
import { deriveOwner } from "@/inngest/owner";

/**
 * The document pipeline (PLAN "Document & Notes Pipeline" §3).
 *
 * ## What this is, right now
 *
 * `validate → finalize`, and both steps do real work: `validate` downloads the
 * bytes Storage actually holds and runs the magic-byte sniff, the encrypted-PDF
 * check, the zip-bomb guard and the 50 MB cap against them; `finalize` marks the
 * document `ready`. A real deck uploaded through the browser walks
 * `queued → validating → ready` through a genuine Inngest run.
 *
 * That is deliberately a **complete two-step pipeline and not a placeholder**.
 * The steps that follow — extract, route, merge, chunk/embed, coverage, deep
 * review — are inserted between `validate` and `finalize` by later agents, into
 * a function that already runs end to end. The alternative, a scaffold that each
 * agent partially fills, is how the previous wave ended up with four working
 * components and no working pipeline: every piece passed its own gate and the
 * connections between them were nobody's deliverable.
 *
 * ## 🔴 Two arguments, not three
 *
 * PLAN §3's sketch uses inngest **v3**'s `createFunction(options, trigger,
 * handler)`. We are on **4.13.0**, where triggers moved into the options object.
 * The v3 form throws *at import time*, which takes down the entire
 * `/api/inngest` route rather than this one function — so the mistake is not a
 * broken feature, it is a broken deployment. PLAN is marked with a dated
 * 🔴 DISPROVEN note; this comment is the second copy, next to the code that
 * would break.
 *
 * ## Why `concurrency` is keyed on the course
 *
 * `limit: 1` per `courseId` means **two uploads to the same course never process
 * simultaneously**, and that is a correctness requirement rather than a
 * politeness. The merge step rewrites `topics` rows in place and bumps
 * `topics.revision` by one; a plain increment is only safe when nothing else is
 * incrementing it, and per-course serialization is what buys that. Uploads to
 * *different* courses still run in parallel, so the serialization costs nothing
 * in the common case.
 *
 * ⚠ The key is a CEL expression over the **raw event**, evaluated by the
 * platform before the handler starts. It therefore reads a field that has not
 * been verified yet — see `events.ts` and `DocumentCourseMismatchError` for what
 * that does and does not cost.
 */
export const processDocument = inngest.createFunction(
  {
    id: "process-document",
    // ⚠ v4: triggers live HERE, in the options object. See the note above.
    triggers: [documentUploaded],
    // PLAN §3. Per-STEP, not per-function: a transient Storage blip re-runs the
    // download, not the whole document.
    retries: 3,
    concurrency: [{ key: "event.data.courseId", limit: 1 }],
    onFailure: markDocumentFailed,
  },
  async ({ event, step }) => {
    // `eventType`'s schema types `event.data` but does NOT validate it on the
    // way in (measured — see the ⚠ block in `events.ts`). Parsing here is what
    // actually satisfies "Zod at every boundary", and it matters more than usual
    // for this handler: an unvalidated id would reach Postgres through the
    // RLS-bypassing admin client and come back as a *retriable* uuid syntax
    // error, burning the whole retry budget on a payload that can never work.
    const parsed = documentUploadedData.safeParse(event.data);
    if (!parsed.success) {
      throw new NonRetriableError(`Malformed document/uploaded event: ${parsed.error.message}`);
    }
    const { documentId, courseId: claimedCourseId } = parsed.data;

    // ── Ownership comes from the database ────────────────────────────────────
    //
    // Its own step so the answer is checkpointed and legible in the dashboard.
    // No `claimed` is passed because the payload carries no `userId` to check it
    // against — which is the *preferred* shape (`events.ts`, rule 8): an event
    // that names only a row id cannot lie about a tenant, because the only
    // tenant it can name is whichever one the database says owns that row.
    const { userId } = await step.run("derive-owner", () =>
      deriveOwner(
        adminClient(),
        { table: "documents", id: documentId },
        { job: "process-document" },
      ),
    );

    // ── Load the row, and check the claim the concurrency key was chosen on ───
    const document = await step.run("load-document", async () => {
      const { data, error } = await adminClient()
        .from("documents")
        // `courses (title)` is joined rather than fetched separately because the
        // extraction prompt needs it and a second round trip for one string is
        // waste. The FK is composite `(course_id, user_id)`, so this join cannot
        // reach another tenant's course even through the admin client.
        .select(
          "id, course_id, storage_path, filename, mime_type, size_bytes, kind, status, courses (title)",
        )
        .eq("id", documentId)
        .eq("user_id", userId)
        .single();

      if (error) throw new Error(`Could not load document ${documentId}: ${error.message}`);

      if (data.course_id !== claimedCourseId) {
        throw new DocumentCourseMismatchError(documentId, claimedCourseId, data.course_id);
      }

      return data;
    });

    // ── validate ─────────────────────────────────────────────────────────────
    const validation = await step.run("validate", async () => {
      const admin = adminClient();

      await setDocumentStatus(admin, documentId, userId, { status: "validating" });
      await logProcessingEvent(admin, {
        userId,
        documentId,
        courseId: document.course_id,
        step: "validate",
        detail: `Checking ${document.filename}.`,
      });

      /** Writes the human reason to the row, then throws. See `DocumentRejectedError`. */
      const rejectWith = async (code: string, message: string): Promise<never> => {
        await setDocumentStatus(admin, documentId, userId, {
          status: "failed",
          failureReason: message,
        });
        await logProcessingEvent(admin, {
          userId,
          documentId,
          courseId: document.course_id,
          step: "validate",
          level: "error",
          detail: message,
        });
        throw new DocumentRejectedError(documentId, code, message);
      };

      // Size first, from the COLUMN — before any download. This is the branch
      // the 164 MB textbook takes, and taking it here means the file is refused
      // without ever being pulled into this function's memory. Reversing the
      // order would make the cap cost more to enforce than to ignore.
      const sizeVerdict = validateDocumentSize({
        sizeBytes: document.size_bytes,
        filename: document.filename,
      });
      if (sizeVerdict !== null && !sizeVerdict.ok) {
        return rejectWith(sizeVerdict.rejection.code, sizeVerdict.rejection.message);
      }

      // Belt and braces against a row whose size_bytes disagrees with Storage:
      // the column is written by the client, so it is a claim like any other.
      // The authoritative size is `bytes.length`, checked inside
      // `validateDocument` below — this guard only keeps the download bounded.
      if (document.size_bytes > MAX_DOCUMENT_BYTES) {
        return rejectWith(
          "too-large",
          `“${document.filename}” is larger than the ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB limit. Compress it or split it, and upload again.`,
        );
      }

      const bytes = await downloadDocumentBytes(admin, document.storage_path);

      // The real check, on the bytes Storage actually holds — never on the
      // client's claimed MIME type, which is a guess from a file extension.
      const verdict = validateDocument({
        bytes,
        filename: document.filename,
        declaredMimeType: document.mime_type,
      });

      if (!verdict.ok) {
        return rejectWith(verdict.rejection.code, verdict.rejection.message);
      }

      // Correct the row to what the bytes say. The stored `mime_type` arrived
      // from the browser; from here on it is the sniffed one, so every later
      // step (and every UI badge) reads a fact rather than a claim.
      await setDocumentStatus(admin, documentId, userId, {
        status: "validating",
        mimeType: verdict.document.mimeType,
      });

      const archive = verdict.document.archive;
      await logProcessingEvent(admin, {
        userId,
        documentId,
        courseId: document.course_id,
        step: "validate",
        detail:
          archive === undefined
            ? `Looks like a valid PDF.`
            : `Looks like a valid PowerPoint file (${archive.entryCount} parts).`,
      });

      return {
        format: verdict.document.format,
        mimeType: verdict.document.mimeType,
        sizeBytes: verdict.document.sizeBytes,
      };
    });

    // ── extract ──────────────────────────────────────────────────────────────
    //
    // §4.1/§4.2. Three routes (native PDF, PPTX XML, PPTX→PDF via CloudConvert)
    // and one `generateObject` on the `doc-structuring` job. This is the first
    // LLM call an Inngest function in this repo makes; see `inngest/extract.ts`.
    //
    // Its own step, so a transport failure re-runs the extraction and not the
    // validation — and so the Inngest dashboard shows where a slow document is
    // actually spending its time. It is by far the longest step in this
    // function, which is why the status UI's watchdog now backs off (see
    // `lib/documents/use-document-feed.ts`).
    const extraction = await step.run("extract", () =>
      runExtract({
        admin: adminClient(),
        userId,
        documentId,
        courseId: document.course_id,
        courseTitle: document.courses?.title ?? "this course",
        filename: document.filename,
        storagePath: document.storage_path,
        format: validation.format,
      }),
    );

    // ── The seam ─────────────────────────────────────────────────────────────
    //
    // segment-and-route → merge:<topic> → chunk-and-embed → coverage → glossary
    // → (syllabus-components | case-brief) → (deep-review) all go HERE, between
    // an extract that works and a finalize that works. Each is a `step.run`
    // inserted into this list; none of them needs to change the steps around it.
    // `extraction` above carries the route, the fidelity and the page counts;
    // the extraction itself is on the `documents` row, because it is far too
    // large to thread through a step's return value.

    // ── finalize ─────────────────────────────────────────────────────────────
    await step.run("finalize", async () => {
      const admin = adminClient();

      // `ready` unconditionally, and that is currently *correct* rather than
      // simplified: PLAN §7 computes `partial` from failed per-topic merges and
      // from embedding failures, and neither of those steps exists yet, so there
      // is no failure this function can observe that would not already have
      // failed the run. When the merge steps land, this is where their results
      // are folded in — `partial` plus `failed_topics`.
      await setDocumentStatus(admin, documentId, userId, {
        status: "ready",
        failureReason: null,
        processedAt: new Date().toISOString(),
      });

      await logProcessingEvent(admin, {
        userId,
        documentId,
        courseId: document.course_id,
        step: "finalize",
        detail: "Done.",
      });
    });

    return {
      documentId,
      courseId: document.course_id,
      status: "ready" as const,
      format: validation.format,
      extraction,
    };
  },
);

/**
 * The `onFailure` hook: a document whose run exhausted its retries must not be
 * left sitting in a mid-pipeline status forever.
 *
 * ## What it deliberately does NOT do
 *
 * It never writes `error.message` into `failure_reason`. By the time this runs
 * the error has been serialized to JSON, so what is available is whatever the
 * throwing code happened to put in a `message` — a Postgres error, a fetch
 * failure, a stack. PLAN §8 is explicit that the user never sees a raw trace,
 * and the reliable way to honour that is to never let arbitrary error text reach
 * a user-visible column in the first place.
 *
 * So it writes a **generic, actionable** sentence, and only when no better one
 * is already there. Steps that know a human reason — `validate` above — write it
 * themselves before throwing, and this hook leaves it alone.
 */
async function markDocumentFailed({
  event,
  step,
}: {
  event: { data: { error: { message: string }; event: { data: unknown } } };
  step: { run: <T>(id: string, fn: () => Promise<T>) => Promise<T> };
}): Promise<void> {
  const parsed = documentUploadedData.safeParse(event.data.event.data);
  if (!parsed.success) {
    // The original event was malformed, so there is no document to mark. Nothing
    // to do, and nothing worth failing over — the run is already failed.
    console.error(
      `[process-document] onFailure could not read the original event: ${parsed.error.message}`,
    );
    return;
  }
  const { documentId } = parsed.data;

  await step.run("mark-failed", async () => {
    const admin = adminClient();

    // Ownership is re-derived here too. `onFailure` is a fresh run with a fresh
    // context, and the rule does not have an exception for cleanup paths — a
    // handler that trusted the payload only on the failure path would be a
    // handler that trusted the payload.
    const { userId } = await deriveOwner(
      admin,
      { table: "documents", id: documentId },
      { job: "process-document.onFailure" },
    );

    const { data: current } = await admin
      .from("documents")
      .select("failure_reason, course_id, status")
      .eq("id", documentId)
      .eq("user_id", userId)
      .single();

    const existingReason = current?.failure_reason ?? null;
    const reason =
      existingReason ??
      "Something went wrong while processing this file, and it didn’t finish after several " +
        "attempts. Try again — if it keeps failing, the file may be damaged.";

    await setDocumentStatus(admin, documentId, userId, {
      status: "failed",
      failureReason: reason,
    });

    if (current?.course_id !== undefined) {
      await logProcessingEvent(admin, {
        userId,
        documentId,
        courseId: current.course_id,
        step: "failed",
        level: "error",
        detail: reason,
      });
    }

    // The raw error goes to the platform log, where it belongs — the Inngest
    // dashboard retains the run for replay after a fix ships (PLAN §7).
    console.error(`[process-document] document ${documentId} failed: ${event.data.error.message}`);
  });
}
