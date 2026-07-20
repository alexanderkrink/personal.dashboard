"use server";

import {
  type DocumentStripPlan,
  planDocumentStrip,
  type TopicPageLike,
  type TopicStripTargetLike,
  validateDocumentSize,
} from "@study/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { inngest } from "@/inngest/client";
import { requireUserId } from "@/lib/auth/require-user";
import { DOCUMENTS_BUCKET, storagePathFor } from "@/lib/documents/paths";
import { createClient } from "@/lib/supabase/server";

/**
 * The upload flow's server half (PLAN §1 step 2, §8 "Upload flow").
 *
 * ## The ordering problem this file exists to solve
 *
 * `documents_storage_path_convention` requires the storage path to be
 * `{user_id}/{course_id}/{document_id}/{filename}` — so the document's **id must
 * exist before the bytes are uploaded**, which forces upload-then-insert. That
 * ordering has a hole, found at Wave 4's gate 1 as finding F5:
 *
 *   1. bytes land in Storage;
 *   2. the INSERT is rejected by `documents_dedupe`;
 *   3. the object is now referenced by no row, and nothing will ever clean it up.
 *
 * The fix is in three parts, and all three are needed:
 *
 *   - **`checkDuplicate` runs BEFORE the upload.** In the ordinary case — the
 *     user re-uploading a deck they already have — no bytes ever move. This
 *     removes the collision, it does not merely tidy up after it.
 *   - **`registerUpload` deletes the object when its own insert fails.** Two
 *     browsers racing the same file both pass the pre-check and one loses at the
 *     unique index; the loser cleans up its own bytes on the way out. This is
 *     the race the pre-check cannot close, closed at the only moment the path is
 *     still known.
 *   - **`sweepOrphanedUploads` exists.** Neither of the above survives a browser
 *     closed mid-upload or a Vercel function killed between the two calls, and a
 *     hole that requires a healthy client to stay closed is not closed. The
 *     sweep makes an orphan *cleanable* rather than permanent, which is the
 *     property F5 actually asks for.
 */

const KIND = z.enum(["slides", "reading", "case", "syllabus"]);

const DUPLICATE_CHECK = z.object({
  courseId: z.uuid(),
  // sha256, lowercase hex. Computed in the browser via SubtleCrypto.
  contentHash: z.string().regex(/^[0-9a-f]{64}$/, "Not a sha256 digest."),
});

export interface DuplicateVerdict {
  readonly duplicate: boolean;
  /** The filename the existing row was uploaded under, when there is one. */
  readonly existingFilename?: string;
  readonly existingStatus?: string;
}

/**
 * "Do we already have these exact bytes in this course?"
 *
 * Called before a single byte is transferred. `documents_dedupe` is
 * `unique (course_id, content_hash)`, so this asks the same question the index
 * will — just early enough that the answer is free.
 *
 * Reads through the **request-scoped** client, so RLS applies and the question
 * can only be asked about the caller's own documents.
 */
export async function checkDuplicate(input: unknown): Promise<DuplicateVerdict> {
  const parsed = DUPLICATE_CHECK.safeParse(input);
  if (!parsed.success) return { duplicate: false };

  const supabase = await createClient();
  await requireUserId(supabase);

  const { data } = await supabase
    .from("documents")
    .select("filename, status")
    .eq("course_id", parsed.data.courseId)
    .eq("content_hash", parsed.data.contentHash)
    .maybeSingle();

  if (!data) return { duplicate: false };
  return { duplicate: true, existingFilename: data.filename, existingStatus: data.status };
}

const REGISTER = z.object({
  /**
   * Generated in the BROWSER, before the upload, because the storage path
   * embeds it (see the header comment). Validated as a uuid here; the check
   * constraint validates the relationship between it and the path.
   */
  documentId: z.uuid(),
  courseId: z.uuid(),
  kind: KIND,
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  deepReview: z.boolean(),
  sessionLabel: z.string().trim().max(120).optional(),
});

export type RegisterResult =
  | { readonly ok: true; readonly documentId: string }
  | { readonly ok: false; readonly message: string };

/**
 * Inserts the `documents` row for bytes that are already in Storage, then asks
 * the pipeline to run.
 *
 * The row lands `status = 'queued'`, which is what the status card renders
 * immediately; everything after that is `process-document`'s to write.
 */
export async function registerUpload(input: unknown): Promise<RegisterResult> {
  const parsed = REGISTER.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "That upload didn’t look right. Try selecting the file again." };
  }
  const upload = parsed.data;

  const supabase = await createClient();
  const userId = await requireUserId(supabase);

  const storagePath = storagePathFor({
    userId,
    courseId: upload.courseId,
    documentId: upload.documentId,
    filename: upload.filename,
  });

  /**
   * Best-effort removal of the bytes this call is about to orphan.
   *
   * Every early return below goes through here, because this function is the
   * last place in the system that knows the path: after it returns without a
   * row, the object is reachable only by the sweep.
   */
  const discardBytes = async (): Promise<void> => {
    const { error } = await supabase.storage.from(DOCUMENTS_BUCKET).remove([storagePath]);
    if (error) {
      console.error(`[upload] could not remove orphaned object ${storagePath}: ${error.message}`);
    }
  };

  // The size cap, restated server-side. The browser checks it first so an
  // oversized file never uploads, but that check runs on the client and is
  // therefore a courtesy rather than a control.
  const sizeVerdict = validateDocumentSize({
    sizeBytes: upload.sizeBytes,
    filename: upload.filename,
  });
  if (sizeVerdict !== null && !sizeVerdict.ok) {
    await discardBytes();
    return { ok: false, message: sizeVerdict.rejection.message };
  }

  // The course must exist and be ours. RLS already guarantees the second half;
  // this turns "insert violates foreign key" into a sentence.
  const { data: course } = await supabase
    .from("courses")
    .select("id")
    .eq("id", upload.courseId)
    .maybeSingle();
  if (!course) {
    await discardBytes();
    return { ok: false, message: "That course no longer exists." };
  }

  /**
   * The bytes must actually be there.
   *
   * Without this, a client that skipped the upload entirely could create a row
   * pointing at nothing, and the pipeline would discover it one Inngest run
   * later as a retriable download failure — three retries and an opaque
   * `failed`. Checking here converts that into an immediate, honest message.
   */
  const { data: listed } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .list(`${userId}/${upload.courseId}/${upload.documentId}`, { limit: 100 });
  if (!listed || listed.length === 0) {
    return {
      ok: false,
      message: "The upload didn’t finish. Check your connection and try again.",
    };
  }

  /**
   * The size the SERVER can see, not the one the browser claimed.
   *
   * `size_bytes` arrives in the request body, is shown to the user, and is what
   * `validate` re-checks the 50 MB cap against — so that guard was circular: a
   * client that under-reported its size would be measured against its own lie.
   * (Bounded, and therefore a data-integrity nit rather than a hole: Storage
   * enforces the real ceiling at 52,428,800 bytes and rejects the transfer
   * itself. But the number is *displayed*, and a displayed number that nothing
   * reconciles will eventually be wrong in front of someone.)
   *
   * The listing was already being fetched to prove the bytes exist, and it
   * carries `metadata.size` — the length Storage actually stored. So the fix
   * costs nothing beyond raising the page limit enough to find the right entry
   * by name.
   *
   * ⚠ The entry is matched on the name Storage actually holds, which is the LAST
   * SEGMENT OF `storagePath` — i.e. `safeStorageFilename(upload.filename)`, not
   * `upload.filename`. The two differ whenever the raw name carries a `/`, `\`,
   * `%`, a leading dot, a control character, surrounding whitespace, or more than
   * 200 characters — `Unit 4 — 50% margin.pptx` is stored as
   * `Unit 4 — 50- margin.pptx`. Matching the raw name means `find` returns
   * `undefined` for exactly those files, the reconciliation silently falls back to
   * the client's claim, and the cap re-check below goes back to measuring the
   * client against its own number — the circularity this block exists to close,
   * restored without a symptom. Deriving the segment from `storagePath` rather
   * than re-deriving it keeps this correct if the sanitiser ever changes.
   */
  const storedName = storagePath.slice(storagePath.lastIndexOf("/") + 1);
  const entry = listed.find((object) => object.name === storedName);
  const listedSize = entry?.metadata?.size;
  const sizeBytes =
    typeof listedSize === "number" && listedSize > 0 ? listedSize : upload.sizeBytes;

  // Re-run the cap against the authoritative number. A file that only fits under
  // the limit while the client is describing it does not fit under the limit.
  const trueSizeVerdict = validateDocumentSize({ sizeBytes, filename: upload.filename });
  if (trueSizeVerdict !== null && !trueSizeVerdict.ok) {
    await discardBytes();
    return { ok: false, message: trueSizeVerdict.rejection.message };
  }

  const { error } = await supabase.from("documents").insert({
    id: upload.documentId,
    user_id: userId,
    course_id: upload.courseId,
    kind: upload.kind,
    storage_path: storagePath,
    filename: upload.filename,
    mime_type: upload.mimeType,
    // Storage's number, falling back to the client's only when the listing did
    // not carry one. See the reconciliation block above.
    size_bytes: sizeBytes,
    content_hash: upload.contentHash,
    status: "queued",
    deep_review: upload.deepReview ? "requested" : "off",
    ...(upload.sessionLabel ? { session_label: upload.sessionLabel } : {}),
  });

  if (error) {
    // 23505 — `documents_dedupe`. The pre-check said this was new, so reaching
    // here means another upload of the same bytes committed in between. This is
    // the F5 race, and this branch is where the losing side cleans up after
    // itself rather than leaving an unreferenced object behind.
    if (error.code === "23505") {
      await discardBytes();
      return {
        ok: false,
        message: "You’ve already uploaded this exact file to this course.",
      };
    }
    // 23514 — a check constraint, in practice `documents_storage_path_convention`.
    if (error.code === "23514") {
      await discardBytes();
      return {
        ok: false,
        message: "That file couldn’t be filed against this course. Try uploading it again.",
      };
    }

    console.error(`[upload] insert failed for ${upload.documentId}: ${error.message}`);
    await discardBytes();
    return { ok: false, message: "That upload didn’t save. Try again." };
  }

  // Only now does the pipeline hear about it. Sending before the insert would
  // race the job against its own row.
  await inngest.send({
    name: "document/uploaded",
    data: { documentId: upload.documentId, courseId: upload.courseId },
  });

  revalidatePath("/documents");
  return { ok: true, documentId: upload.documentId };
}

const DOCUMENT_REF = z.object({ documentId: z.uuid() });

/**
 * What deleting this document will actually do — the numbers the confirmation
 * dialog states before anything is destroyed.
 *
 * Every field is a *measurement*, not an estimate: each one is read from the rows
 * that are about to change. `stale…` fields are the honest half — content the
 * strip provably cannot attribute and therefore will not remove.
 */
export interface DeleteImpact {
  readonly filename: string;
  /** Titles of topics that disappear entirely — this document was their only source. */
  readonly topicsRemoved: readonly string[];
  /** Titles of topics that survive with this document's blocks taken out of the page. */
  readonly topicsRewritten: readonly string[];
  /** Blocks removed from surviving pages. */
  readonly blocksRemoved: number;
  /** Blocks left on surviving pages because nothing attributed them to any document. */
  readonly blocksUnattributed: number;
  /** Surviving topics whose summary paragraph may still describe removed content. */
  readonly staleSummaries: number;
  /** `document_chunks` rows that go with the document. */
  readonly chunks: number;
}

/**
 * Reads everything the strip needs, and plans it. No writes.
 *
 * Shared by the preview and the delete so the dialog and the action can never
 * disagree about what is going to happen — the same function produces both.
 *
 * Every read goes through the **request-scoped** client, so RLS bounds all of it
 * to the caller's own rows; a documentId belonging to another tenant simply
 * returns nothing rather than leaking a title.
 */
async function planStrip(
  supabase: Awaited<ReturnType<typeof createClient>>,
  documentId: string,
): Promise<
  | { readonly ok: false }
  | {
      readonly ok: true;
      readonly document: {
        readonly id: string;
        readonly filename: string;
        readonly storage_path: string;
      };
      readonly plan: DocumentStripPlan;
      readonly chunks: number;
    }
> {
  const { data: document } = await supabase
    .from("documents")
    .select("id, filename, storage_path")
    .eq("id", documentId)
    .maybeSingle();
  if (!document) return { ok: false };

  // Which topics this document was merged into.
  const { data: ourSources } = await supabase
    .from("topic_sources")
    .select("topic_id")
    .eq("document_id", document.id);

  const topicIds = [...new Set((ourSources ?? []).map((row) => row.topic_id))];

  const { count: chunks } = await supabase
    .from("document_chunks")
    .select("id", { count: "exact", head: true })
    .eq("document_id", document.id);

  let topics: TopicStripTargetLike[] = [];
  if (topicIds.length > 0) {
    const [{ data: topicRows }, { data: allSources }] = await Promise.all([
      supabase.from("topics").select("id, title, page").in("id", topicIds),
      // EVERY source on those topics, not just ours — that is what decides whether a
      // topic survives the delete at all.
      supabase.from("topic_sources").select("topic_id, document_id").in("topic_id", topicIds),
    ]);

    const sourcesByTopic = new Map<string, string[]>();
    for (const row of allSources ?? []) {
      const list = sourcesByTopic.get(row.topic_id);
      if (list) list.push(row.document_id);
      else sourcesByTopic.set(row.topic_id, [row.document_id]);
    }

    topics = (topicRows ?? []).map((row) => ({
      topicId: row.id,
      title: row.title,
      // `topics.page` is `jsonb not null default '{}'`, so anything could be in there. The
      // strip is typed structurally and tolerates every field being absent; a page stored as
      // a JSON array or scalar is not a page and is treated as empty rather than thrown on.
      page:
        typeof row.page === "object" && row.page !== null && !Array.isArray(row.page)
          ? (row.page as TopicPageLike)
          : {},
      sourceDocumentIds: sourcesByTopic.get(row.id) ?? [],
    }));
  }

  return {
    ok: true,
    document,
    plan: planDocumentStrip({ documentId: document.id, topics }),
    chunks: chunks ?? 0,
  };
}

/**
 * "What happens if I delete this?" — answered before the button is pressed.
 *
 * Pure read. The dialog calls this on open so the confirmation can name the
 * topics that will disappear rather than describing the delete in the abstract.
 */
export async function previewDocumentDelete(input: unknown): Promise<DeleteImpact | null> {
  const parsed = DOCUMENT_REF.safeParse(input);
  if (!parsed.success) return null;

  const supabase = await createClient();
  await requireUserId(supabase);

  const planned = await planStrip(supabase, parsed.data.documentId);
  if (!planned.ok) return null;

  const { plan } = planned;
  return {
    filename: planned.document.filename,
    topicsRemoved: plan.verdicts
      .filter((verdict) => verdict.kind === "remove-topic")
      .map((verdict) => verdict.title),
    topicsRewritten: plan.verdicts
      .filter((verdict) => verdict.kind === "rewrite-page")
      .map((verdict) => verdict.title),
    blocksRemoved: plan.blocksRemoved,
    blocksUnattributed: plan.blocksUnattributed,
    staleSummaries: plan.staleSummaries,
    chunks: planned.chunks,
  };
}

/**
 * Deletes a document, its bytes, its provenance, its chunks — and its contribution
 * to the topic pages it was merged into (PLAN §5's *strip*, PLAN §8's *Delete*).
 *
 * ## ✅ DECIDED 2026-07-20 — the strip is built, by block provenance rather than snapshot replay
 *
 * PLAN §5 carried a 🔴 DISPROVEN / ⚠ CORRECTED block saying the strip was still
 * owed. It is now built, and it takes a different route than §5 specifies —
 * `@study/core`'s `stripDocumentFromPage` filters the page by each block's own
 * `sources[].documentId` instead of replaying revisions forward from a
 * `topic_revisions` snapshot. The full reasoning is in that module's header; the
 * short version is that `topic_revisions` was **empty** on production (the create
 * path writes no snapshot), so a replay had no base for any topic that existed,
 * and re-applying a later document's revision onto a different base is a
 * three-way merge of LLM prose rather than the deterministic operation §5
 * promises. Block provenance is exact, per-block, and needs no history.
 *
 * ## What is removed, and by whom
 *
 * | Thing | Removed by |
 * | --- | --- |
 * | `documents` row | this function |
 * | `document_processing_events` | FK cascade |
 * | `topic_sources` | FK cascade |
 * | `document_chunks` (`source = 'document'`) | FK cascade |
 * | a topic whose ONLY source was this document | `topic_sources_delete_sourceless_topic` trigger |
 * | that topic's `source = 'topic_page'` chunks | `topics_delete_synthesized_chunks` trigger |
 * | this document's blocks on a SURVIVING topic's page | this function, via the strip |
 * | the storage object | this function |
 *
 * `topic_revisions` is **not** touched: it is append-only immutable history
 * (`using (false)` on UPDATE and DELETE) and its `document_id` FK is
 * `on delete set null (document_id)`, so the history survives with its provenance
 * nulled. That is the designed behaviour, not an oversight.
 *
 * ## What is deliberately NOT removed
 *
 * A surviving topic's `summary` paragraph, and any block whose sources name no
 * document. Neither carries the provenance needed to attribute it, and guessing
 * would delete another document's content. Both are counted in {@link DeleteImpact}
 * and stated in the confirmation dialog.
 *
 * ## Ordering
 *
 * Plan → delete row → strip surviving pages → delete object.
 *
 * The row goes first for the reason the original version of this function
 * documented: the reverse order leaves a row pointing at nothing, which reads as
 * a document that exists but cannot be processed. The strip runs *after* because
 * the cascade is what removes the sourceless topics, so by then the only topics
 * left to rewrite are the ones that genuinely survived. A failure between the two
 * leaves stale blocks on a surviving page — visible, re-strippable, and strictly
 * better than the alternative failure of deleting content for a document that
 * still exists.
 */
export async function deleteDocument(input: unknown): Promise<{ ok: boolean; message?: string }> {
  const parsed = DOCUMENT_REF.safeParse(input);
  if (!parsed.success) return { ok: false, message: "That document no longer exists." };

  const supabase = await createClient();
  const userId = await requireUserId(supabase);

  const planned = await planStrip(supabase, parsed.data.documentId);
  if (!planned.ok) return { ok: false, message: "That document no longer exists." };
  const { document, plan } = planned;

  const { error } = await supabase
    .from("documents")
    .delete()
    .eq("id", document.id)
    // RLS already bounds this to the caller. Restated because a DELETE is the one
    // statement where a policy regression is unrecoverable rather than merely wrong.
    .eq("user_id", userId);
  if (error) return { ok: false, message: "That didn’t delete. Try again." };

  // Surviving topics only. `remove-topic` verdicts were carried out by the cascade
  // above, and `unchanged` ones have nothing to write.
  for (const verdict of plan.verdicts) {
    if (verdict.kind !== "rewrite-page") continue;

    const { error: pageError } = await supabase
      .from("topics")
      .update({ page: verdict.page as never })
      .eq("id", verdict.topicId)
      .eq("user_id", userId);
    if (pageError) {
      console.error(
        `[delete] stripped row ${document.id} but not topic ${verdict.topicId}: ${pageError.message}`,
      );
    }
  }

  const { error: storageError } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .remove([document.storage_path]);
  if (storageError) {
    console.error(
      `[delete] deleted row ${document.id} but not ${document.storage_path}: ${storageError.message}`,
    );
  }

  // No `/topics` route exists yet, so there is nothing else to revalidate. When the topic
  // pages land, a stripped topic needs revalidating here too.
  revalidatePath("/documents");
  return { ok: true };
}

/**
 * Re-runs the pipeline for a document that failed (PLAN §8's *Try again*).
 *
 * Resets to `queued` and clears the old reason, so the status card does not show
 * a stale failure next to a running pipeline. The bytes are untouched — they are
 * still in Storage under the same path, which is the whole reason a retry is
 * cheap.
 *
 * Note this is NOT `document/retry-merges` (PLAN §7's partial-success retry).
 * That event re-runs only the failed topic merges and belongs with the agent
 * that builds them; this one re-runs the document.
 *
 * ## ⚠ This is a RETRY, not PLAN §5's "Reprocess"
 *
 * A retry converges: `runRouteAndMerge` now recognises the topics this document
 * already merged into and skips them, so the re-run finishes the topics that did
 * not persist and leaves the rest exactly as they are. Before 2026-07-20 it
 * compounded — another `topic_revisions` row and another `revision` bump per
 * already-merged topic, at ~$0.06 of re-billed merge + critic each.
 *
 * What it still does NOT do is **strip**. PLAN §5 says re-processing first
 * replays each topic forward from the snapshot taken before this document's
 * first merge, re-applying only other documents' revisions, then deletes this
 * document's `topic_sources` rows and chunks and runs fresh. None of that
 * exists (PLAN §5 carries the 🔴 DISPROVEN 2026-07-20 note). The practical
 * consequence: a retry re-extracts the file — that step is not memoized across a
 * fresh `document/uploaded` — but any topic already merged keeps the page it
 * has, so a *changed* extraction cannot rebuild a page it already contributed
 * to. That is the right trade for "finish the rest" and the wrong one for a true
 * "Reprocess", which is why the strip is still owed.
 */
export async function retryDocument(input: unknown): Promise<{ ok: boolean; message?: string }> {
  const parsed = DOCUMENT_REF.safeParse(input);
  if (!parsed.success) return { ok: false, message: "That document no longer exists." };

  const supabase = await createClient();
  await requireUserId(supabase);

  const { data: document } = await supabase
    .from("documents")
    .select("id, course_id, status")
    .eq("id", parsed.data.documentId)
    .maybeSingle();
  if (!document) return { ok: false, message: "That document no longer exists." };

  // Only from a terminal state. Re-queuing a document mid-run would put two
  // runs on the same row, and the per-course concurrency limit serializes them
  // rather than preventing the second — so the guard has to be here.
  if (document.status !== "failed" && document.status !== "partial") {
    return { ok: false, message: "That document is already being processed." };
  }

  const { error } = await supabase
    .from("documents")
    .update({ status: "queued", failure_reason: null })
    .eq("id", document.id);
  if (error) return { ok: false, message: "That didn’t restart. Try again." };

  await inngest.send({
    name: "document/uploaded",
    data: { documentId: document.id, courseId: document.course_id },
  });

  revalidatePath("/documents");
  return { ok: true };
}

const SWEEP = z.object({ courseId: z.uuid() });

export interface SweepResult {
  readonly removed: number;
  readonly message?: string;
}

/**
 * Deletes storage objects under this course that no `documents` row references.
 *
 * ## Why this is a real feature and not a maintenance script
 *
 * Gate 1's F5 says an orphan must be "cleanable, not permanent". The two
 * inline defences above are both *client-dependent*: they need the browser to
 * still be there when the insert fails. A closed tab, a killed function or a
 * dropped connection between "TUS completed" and "registerUpload returned"
 * leaves bytes behind with no row, and no amount of care in the happy path
 * changes that. Something has to be able to notice afterwards, and this is it.
 *
 * The definition of an orphan is deliberately strict — a top-level folder under
 * `{user}/{course}/` whose name is a document id with no matching row. The path
 * convention is what makes that decidable without guessing: every object lives
 * under exactly one document id, so "is this referenced?" is a primary-key
 * lookup rather than a heuristic.
 *
 * Runs under the **request-scoped** client, so it is RLS-bounded to the caller's
 * own objects. A sweep that used the admin client could delete another tenant's
 * bytes on a bad courseId; this one physically cannot.
 */
export async function sweepOrphanedUploads(input: unknown): Promise<SweepResult> {
  const parsed = SWEEP.safeParse(input);
  if (!parsed.success) return { removed: 0, message: "That course no longer exists." };

  const supabase = await createClient();
  const userId = await requireUserId(supabase);
  const prefix = `${userId}/${parsed.data.courseId}`;

  const { data: folders, error: listError } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .list(prefix, { limit: 1000 });
  if (listError || !folders) return { removed: 0 };

  const candidateIds = folders
    .map((entry) => entry.name)
    .filter((name) => z.uuid().safeParse(name).success);
  if (candidateIds.length === 0) return { removed: 0 };

  const { data: live } = await supabase
    .from("documents")
    .select("id")
    .eq("course_id", parsed.data.courseId)
    .in("id", candidateIds);

  const referenced = new Set((live ?? []).map((row) => row.id));
  const orphanIds = candidateIds.filter((id) => !referenced.has(id));
  if (orphanIds.length === 0) return { removed: 0 };

  // `remove` takes object paths, not prefixes, so each orphan folder is listed
  // and its contents named explicitly.
  const objectPaths: string[] = [];
  for (const orphanId of orphanIds) {
    const { data: contents } = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .list(`${prefix}/${orphanId}`, { limit: 100 });
    for (const object of contents ?? []) {
      objectPaths.push(`${prefix}/${orphanId}/${object.name}`);
    }
  }
  if (objectPaths.length === 0) return { removed: 0 };

  const { error: removeError } = await supabase.storage.from(DOCUMENTS_BUCKET).remove(objectPaths);
  if (removeError) {
    return { removed: 0, message: "Couldn’t clear the leftover files. Try again." };
  }

  revalidatePath("/documents");
  return { removed: objectPaths.length };
}
