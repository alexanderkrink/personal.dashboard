import {
  computeDocumentOutcome,
  MAX_DOCUMENT_BYTES,
  outcomeMessage,
  validateDocument,
  validateDocumentSize,
} from "@study/core";
import { NonRetriableError } from "inngest";
import { budgetCheckpoint } from "@/inngest/budget";
import { runChunkAndEmbed } from "@/inngest/chunk-and-embed";
import { inngest } from "@/inngest/client";
import { runCoverage } from "@/inngest/coverage";
import { runDeepReview } from "@/inngest/deep-review";
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
import { runRouteAndMerge } from "@/inngest/route-and-merge";
import { createStudyAIRuntime } from "@/lib/ai/runtime";

/**
 * The document pipeline (PLAN "Document & Notes Pipeline" §3).
 *
 * ## What this is, right now
 *
 * `validate → extract → route-and-merge → finalize`, and every step does real
 * work: `validate` downloads the bytes Storage actually holds and runs the
 * magic-byte sniff, the encrypted-PDF check, the zip-bomb guard and the 50 MB
 * cap against them; `extract` turns the file into structured study material
 * through one metered multimodal call; `route-and-merge` is PLAN §5 Steps A–C —
 * segment, embed, retrieve, route, duplicate-guard, merge, verify, persist; and
 * `finalize` computes §7's `ready` / `partial` / `failed`. A real deck uploaded
 * through the browser walks `queued → validating → extracting → merging →
 * ready` through a genuine Inngest run and comes out the other side as topic
 * pages.
 *
 * Each step was **inserted into a function that already ran end to end**, rather
 * than filled into a scaffold. The alternative is how the previous wave ended up
 * with four working components and no working pipeline: every piece passed its
 * own gate and the connections between them were nobody's deliverable.
 *
 * Still to be inserted, at the seam below `route-and-merge`: chunk/embed,
 * coverage, glossary, and the opt-in deep-review audit.
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

    // ── The money guard's window (§7) ────────────────────────────────────────
    //
    // `ai_generations` has no `document_id`, so per-document spend is scoped by
    // user, by the pipeline's job set, and by this timestamp. Its own step so it
    // is **memoized**: a retried run must measure from the original start, not
    // from the retry's, or each attempt would reset the fuse and a looping
    // document would never trip it. See `inngest/budget.ts`.
    const runStartedAt = await step.run("run-started-at", () => new Date().toISOString());

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

    // ── route & merge ────────────────────────────────────────────────────────
    //
    // PLAN §5 Steps A–C, the heart of the product invariant: a course's topic
    // set is a stable, growing index that documents *contribute to*. Segment,
    // embed, retrieve, one batched routing call, the deterministic duplicate
    // guard, one Sonnet merge per affected topic, the loss-detector plus a
    // cross-family Gemini critic, and the per-topic persist.
    //
    // One step rather than one per topic — see the note on `runRouteAndMerge`.
    // The per-topic isolation PLAN §7 asks for comes from the `try` inside it,
    // which is what makes `partial` reachable at all.
    const merge = await step.run("route-and-merge", () =>
      runRouteAndMerge({
        admin: adminClient(),
        userId,
        documentId,
        courseId: document.course_id,
        courseTitle: document.courses?.title ?? "this course",
        filename: document.filename,
        sessionLabel: extraction.sessionLabel,
      }),
    );

    // ── Money guard checkpoint (§7) ──────────────────────────────────────────
    //
    // Placed here rather than at the end, because a fuse that blows after the
    // spending is a receipt. Extraction and merge are the two expensive stages
    // and both are now behind it; everything below is cents by comparison,
    // except the opt-in audit, which gets its own checkpoint.
    await step.run("budget-after-merge", () =>
      budgetCheckpoint({
        admin: adminClient(),
        userId,
        documentId,
        courseId: document.course_id,
        runStartedAt,
        stage: "after merge",
      }),
    );

    // ── Which topics this document actually contributed to ───────────────────
    //
    // Read from `topic_sources` rather than taken from `merge`'s return value:
    // that table is the persisted truth about what landed, so after a *partial*
    // run it names the topics that really were updated rather than the ones the
    // step intended to update. Both the chunk step and `course/topics.changed`
    // need this list, so it is derived once.
    const touchedTopicIds = await step.run("load-touched-topics", async () => {
      const { data, error } = await adminClient()
        .from("topic_sources")
        .select("topic_id")
        .eq("user_id", userId)
        .eq("document_id", documentId);

      if (error) {
        throw new Error(`Could not read topic sources for ${documentId}: ${error.message}`);
      }
      return [...new Set((data ?? []).map((row) => row.topic_id))];
    });

    // ── chunk & embed ────────────────────────────────────────────────────────
    //
    // §6. Structure-aware chunking in `@study/core`, Voyage embeddings through
    // the metered client, and the topic pages themselves indexed alongside the
    // raw document so search covers the notes.
    //
    // ⚠ Its own step AND its own `try`. PLAN §7 puts embedding failures on the
    // `partial` path — "the topic pages are readable even when search indexing
    // lags" — and a step that threw would instead retry three times and then
    // fail a document whose pages are complete. The module never throws on an
    // embedding failure; this catch is for everything else it touches.
    const indexing = await step.run("chunk-and-embed", async () => {
      try {
        return await runChunkAndEmbed({
          admin: adminClient(),
          userId,
          documentId,
          courseId: document.course_id,
          kind: document.kind,
          filename: document.filename,
          topicIds: touchedTopicIds,
        });
      } catch (error) {
        console.error(`[process-document] indexing failed for ${documentId}:`, error);
        await logProcessingEvent(adminClient(), {
          userId,
          documentId,
          courseId: document.course_id,
          step: "embed",
          level: "warn",
          detail:
            "Your topic pages are complete, but this file couldn’t be indexed for search yet. Everything is readable; search will catch up on the next run.",
        });
        return null;
      }
    });

    // ── coverage ─────────────────────────────────────────────────────────────
    //
    // The deterministic map plus, when the course has a syllabus, the §5
    // checklist. Same isolation and the same reason: coverage is a *report* on
    // the work, and failing a document because its report could not be written
    // would be the tail wagging the dog.
    const coverage = await step.run("coverage", async () => {
      try {
        return await runCoverage({
          admin: adminClient(),
          userId,
          documentId,
          courseId: document.course_id,
          courseTitle: document.courses?.title ?? "this course",
          runtime: createStudyAIRuntime({ userId }),
        });
      } catch (error) {
        console.error(`[process-document] coverage failed for ${documentId}:`, error);
        return null;
      }
    });

    // ── Step D — the opt-in deep-review audit ────────────────────────────────
    //
    // Runs only when `documents.deep_review = 'requested'`; the module returns
    // immediately otherwise, which is why this is an unconditional step rather
    // than a branch — a conditional `step.run` changes the run's step list
    // between attempts, and Inngest memoizes by step id.
    //
    // Its own budget checkpoint first: this is the one call in the pipeline that
    // can cost more than everything above it combined (~$0.80–2.00 on Opus), so
    // the ceiling is consulted immediately before it rather than after.
    await step.run("budget-before-deep-review", () =>
      budgetCheckpoint({
        admin: adminClient(),
        userId,
        documentId,
        courseId: document.course_id,
        runStartedAt,
        stage: "before deep review",
      }),
    );

    const deepReview = await step.run("deep-review", async () => {
      try {
        return await runDeepReview({
          admin: adminClient(),
          userId,
          documentId,
          courseId: document.course_id,
          courseTitle: document.courses?.title ?? "this course",
          filename: document.filename,
          sessionLabel: extraction.sessionLabel,
          runtime: createStudyAIRuntime({ userId }),
        });
      } catch (error) {
        // An optional second opinion must never be able to fail a document whose
        // pages are already written. `runDeepReview` resets `deep_review` to
        // `'requested'` on its own dead-letter path so a retry re-runs it.
        console.error(`[process-document] deep review failed for ${documentId}:`, error);
        return null;
      }
    });

    // ── finalize ─────────────────────────────────────────────────────────────
    //
    // The three-way outcome is recomputed here rather than reused from `merge`,
    // because the steps above can degrade it: §7 puts embedding failures on the
    // `partial` path, and that fact is only known now.
    const outcome = computeDocumentOutcome({
      topicOutcomes: merge.topicOutcomes,
      degraded: indexing === null || indexing.degraded,
    });

    await step.run("finalize", async () => {
      const admin = adminClient();

      // §7's three-way computation. `partial` is a real outcome: some topics
      // merged, some did not — or everything merged but search indexing lagged.
      //
      // `failure_reason` gets a sentence from `outcomeMessage`, never an error
      // string — §8's rule, enforced by keeping the per-topic error text in
      // `failed_topics` (for the retry path) and in the processing feed (for a
      // human) and out of the column the user reads.
      const { error } = await admin
        .from("documents")
        // Spread into a mutable array: `DocumentOutcome.failedTopics` is `readonly`, and
        // the generated `Json` type is not. This used to compile only because `outcome`
        // arrived through a `step.run` return value, which Inngest's serialization type
        // strips `readonly` from — recomputing it in the handler brings the modifier back.
        .update({ failed_topics: outcome.failedTopics.map((topic) => ({ ...topic })) })
        .eq("id", documentId)
        .eq("user_id", userId);
      if (error) {
        throw new Error(`Could not record failed topics for ${documentId}: ${error.message}`);
      }

      await setDocumentStatus(admin, documentId, userId, {
        status: outcome.status,
        failureReason: outcomeMessage(outcome),
        processedAt: new Date().toISOString(),
      });

      const reviewNote =
        outcome.needsReviewCount === 0 ? "" : ` ${outcome.needsReviewCount} flagged for review.`;

      await logProcessingEvent(admin, {
        userId,
        documentId,
        courseId: document.course_id,
        step: "finalize",
        level: outcome.status === "ready" ? "info" : "warn",
        detail:
          outcome.status === "failed"
            ? "Finished, but none of the topic pages could be updated."
            : `Done. ${outcome.mergedCount} topic${outcome.mergedCount === 1 ? "" : "s"} updated${
                merge.topicsCreated === 0 ? "" : ` (${merge.topicsCreated} new)`
              }.${reviewNote}${
                outcome.failedTopics.length === 0
                  ? ""
                  : ` ${outcome.failedTopics.length} could not be updated — retry to finish them.`
              }${coverage === null ? "" : ` ${coverage.summary}.`}${
                deepReview === null || deepReview.changes === 0
                  ? ""
                  : ` Deep review changed ${deepReview.changes} thing${deepReview.changes === 1 ? "" : "s"}.`
              }${merge.costUsd === null ? "" : ` Cost $${merge.costUsd.toFixed(4)}.`}`,
      });
    });

    // ── The two terminal events ──────────────────────────────────────────────
    //
    // Agent 2 deliberately did not send these because nothing consumed them.
    // Both have consumers now, so both are sent — and both are sent from their
    // own `step.run`, which is what makes them **exactly-once per run** rather
    // than once per attempt. `step.sendEvent` is not used because these are
    // fire-and-forget notifications: a send that fails must not fail a document
    // that has already finished successfully and written its status.
    //
    // Order matters slightly: `course/topics.changed` first, so that a review is
    // already marked stale by the time anything reacting to `document/ready`
    // goes looking at it.
    if (touchedTopicIds.length > 0) {
      await step.run("emit-topics-changed", async () => {
        try {
          await inngest.send({
            name: "course/topics.changed",
            data: {
              courseId: document.course_id,
              documentId,
              topicIds: touchedTopicIds,
            },
          });
        } catch (sendError) {
          console.error(`[process-document] could not emit course/topics.changed:`, sendError);
        }
        return { sent: touchedTopicIds.length };
      });
    }

    await step.run("emit-document-ready", async () => {
      try {
        await inngest.send({
          name: "document/ready",
          data: { documentId, courseId: document.course_id, status: outcome.status },
        });
      } catch (sendError) {
        console.error(`[process-document] could not emit document/ready:`, sendError);
      }
      return { status: outcome.status };
    });

    return {
      documentId,
      courseId: document.course_id,
      status: outcome.status,
      format: validation.format,
      extraction,
      merge,
      indexing,
      coverage: coverage === null ? null : coverage.summary,
      deepReview,
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
