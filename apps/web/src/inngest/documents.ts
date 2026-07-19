/**
 * Shared plumbing for the document pipeline's steps.
 *
 * `process-document` currently runs `validate → finalize`. Extraction, routing,
 * merging, chunking and the deep-review audit are separate agents' steps, and
 * they will be *inserted into a function that already runs* rather than bolted
 * onto a stub. This module is the seam that makes that cheap: every step needs
 * the same four things — an admin client, a line in the progress feed, a status
 * transition, and a way to fail with a sentence a person can read — so they live
 * here once instead of being re-invented per step.
 *
 * ## The one rule for anything added here
 *
 * `userId` is never a parameter that a caller *chooses*. It arrives from
 * `deriveOwner()` and is threaded through. These helpers take it as an argument
 * because they are called from inside steps that already derived it; none of
 * them may ever read it from an event payload. See `inngest/owner.ts`.
 */

import { createAdminSupabaseClient, type SupabaseAdminClient } from "@study/db";
import { NonRetriableError } from "inngest";
import { env } from "@/env";

/** The bucket documents land in (20260719092113). Private; admin reads bypass its RLS. */
export const DOCUMENTS_BUCKET = "documents";

/**
 * A fresh admin client.
 *
 * Built per call rather than hoisted to module scope, for the reason
 * `health-check.ts` gives: steps are separate HTTP invocations that may land on
 * different serverless instances, so a shared instance would be rebuilt anyway,
 * and constructing it at the point of use keeps the secret read next to its
 * single use.
 */
export function adminClient(): SupabaseAdminClient {
  return createAdminSupabaseClient({
    url: env.NEXT_PUBLIC_SUPABASE_URL,
    secretKey: env.SUPABASE_SECRET_KEY,
  });
}

/**
 * A failure the user is allowed to read.
 *
 * ## Why the message is written to the row *before* this is thrown
 *
 * The obvious design is to carry the user-facing text on the error and let
 * `onFailure` write it. That does not survive the trip: `onFailure` receives the
 * error **serialized to JSON** (`FailureEventPayload["data"]["error"]`), so the
 * class is gone and only `name`/`message`/`stack` remain. Reconstructing intent
 * from a string means either matching on `name` — brittle — or writing
 * `error.message` into `failure_reason`, which is precisely how a stack trace
 * ends up in front of a user, and PLAN §8 forbids exactly that.
 *
 * So the contract is inverted: **whoever knows the human reason writes it to the
 * row, then throws.** `onFailure` is left with one job it can do without any
 * knowledge of the error — make sure the row ends up `failed`, and supply a
 * generic reason only if nothing better is already there. That is why
 * `markDocumentFailed` writes `failure_reason` conditionally.
 *
 * `NonRetriableError` because a rejected file is rejected identically on every
 * attempt. Retrying a password-protected PDF three times produces the same PDF.
 */
export class DocumentRejectedError extends NonRetriableError {
  constructor(
    readonly documentId: string,
    readonly code: string,
    userMessage: string,
  ) {
    super(`Document ${documentId} rejected (${code}): ${userMessage}`);
    this.name = "DocumentRejectedError";
  }
}

/**
 * Raised when the event's `courseId` is not the course the document belongs to.
 *
 * The payload's `courseId` exists to drive the concurrency key (see
 * `events.ts`), which means it is consumed by the platform before any check can
 * run. That makes it the one field in this pipeline that acts on unverified
 * input, so the handler verifies it at the first opportunity and refuses rather
 * than proceeding with a document whose serialization lane was chosen by a claim
 * the database disagrees with.
 *
 * Non-retriable for the same reason `OwnerMismatchError` is: the disagreement is
 * a property of the stored event and is identical on every attempt.
 */
export class DocumentCourseMismatchError extends NonRetriableError {
  constructor(documentId: string, claimed: string, actual: string) {
    super(
      `Event claimed courseId ${claimed} for document ${documentId}, but the row belongs to ` +
        `course ${actual}. Refusing: the claimed course chose this run's concurrency lane, so a ` +
        "mismatch means the run was serialized against the wrong course.",
    );
    this.name = "DocumentCourseMismatchError";
  }
}

/** Levels the progress feed accepts (`document_processing_events.level`). */
export type ProcessingLevel = "info" | "warn" | "error";

export interface ProcessingEventInput {
  readonly userId: string;
  readonly documentId: string;
  readonly courseId: string;
  /** Free-form step name — 'validate', 'extract', 'merge:topic:<id>'. */
  readonly step: string;
  readonly level?: ProcessingLevel;
  /** One short sentence. Rendered verbatim in the status card. */
  readonly detail?: string;
}

/**
 * Appends a line to the progress feed the status UI renders.
 *
 * Deliberately **best-effort**: a failure to write a log line is swallowed with
 * a console error rather than thrown. The feed is a narration of the work, not
 * the work — failing a document that extracted perfectly well because its
 * commentary could not be persisted would be the tail wagging the dog. The
 * authoritative state is `documents.status`, which is written by
 * `setDocumentStatus` and whose failures *are* fatal.
 */
export async function logProcessingEvent(
  admin: SupabaseAdminClient,
  input: ProcessingEventInput,
): Promise<void> {
  const { error } = await admin.from("document_processing_events").insert({
    user_id: input.userId,
    document_id: input.documentId,
    course_id: input.courseId,
    step: input.step,
    level: input.level ?? "info",
    detail: input.detail ?? null,
  });

  if (error) {
    console.error(
      `[process-document] could not log '${input.step}' for document ${input.documentId}: ${error.message}`,
    );
  }
}

/** The pipeline states a step may move a document into. */
export type DocumentStatus =
  | "queued"
  | "validating"
  | "extracting"
  | "structuring"
  | "merging"
  | "embedding"
  | "ready"
  | "partial"
  | "failed";

export interface StatusPatch {
  readonly status: DocumentStatus;
  /** User-readable. Only ever set on `failed` / `partial`. Never a stack trace. */
  readonly failureReason?: string | null;
  readonly mimeType?: string;
  readonly processedAt?: string;
}

/**
 * Moves a document to a new status.
 *
 * Scoped by `(id, user_id)` rather than by `id` alone. The admin client bypasses
 * RLS, so the `user_id` term is not decoration — it is the only thing making
 * this write refuse to touch another tenant's row if a document id ever reached
 * it from the wrong place. It costs nothing (`documents_id_user_key` indexes
 * exactly this pair) and it means a mistake upstream produces zero rows updated
 * instead of a cross-tenant write.
 *
 * Throws on failure: unlike the progress feed, the status IS the product.
 */
export async function setDocumentStatus(
  admin: SupabaseAdminClient,
  documentId: string,
  userId: string,
  patch: StatusPatch,
): Promise<void> {
  const { error } = await admin
    .from("documents")
    .update({
      status: patch.status,
      ...(patch.failureReason !== undefined ? { failure_reason: patch.failureReason } : {}),
      ...(patch.mimeType !== undefined ? { mime_type: patch.mimeType } : {}),
      ...(patch.processedAt !== undefined ? { processed_at: patch.processedAt } : {}),
    })
    .eq("id", documentId)
    .eq("user_id", userId);

  if (error) {
    throw new Error(`Could not set document ${documentId} to '${patch.status}': ${error.message}`);
  }
}

/**
 * Downloads a document's bytes from Storage.
 *
 * Only ever called after the size check has passed, which is what keeps this
 * bounded: the caller knows `size_bytes` from the row and refuses anything over
 * the 50 MB cap *without* downloading it. Reversing that order would mean
 * pulling a 164 MB textbook into a function's memory in order to discover it is
 * too large — the exact cost the cap exists to avoid.
 */
export async function downloadDocumentBytes(
  admin: SupabaseAdminClient,
  storagePath: string,
): Promise<Uint8Array> {
  const { data, error } = await admin.storage.from(DOCUMENTS_BUCKET).download(storagePath);

  if (error !== null || data === null) {
    // Retriable (a plain Error): Storage being briefly unreachable says nothing
    // about the file, and the next attempt may well succeed.
    throw new Error(`Could not download ${storagePath}: ${error?.message ?? "no data returned"}`);
  }

  return new Uint8Array(await data.arrayBuffer());
}

/** How long an extraction's signed URL stays valid. Generous; the step uses it at once. */
const SIGNED_URL_TTL_SECONDS = 600;

/**
 * Downloads a document's bytes through a **signed URL** (PLAN §4.1's mechanics).
 *
 * `downloadDocumentBytes` above pulls the same bytes through the storage client and is
 * simpler, so the difference is worth stating rather than leaving as an inconsistency:
 *
 *   - §4.1 specifies this path explicitly, and Gate 2 measured it end to end —
 *     `createSignedUrl` → `GET` → `200`, bytes byte-identical — precisely to derisk this
 *     step. Using the path that was verified beats using the one that was not.
 *   - It is the only shape that generalizes. Handing a *URL* to a provider that fetches
 *     the file itself (Gemini's File API, for large PDFs) is a change of one argument from
 *     here and a rewrite from the download path.
 *
 * The TTL is long enough that a slow extraction cannot outlive its own URL, and short
 * enough that a URL leaked into a log is not a durable handle on a private bucket.
 */
export async function downloadViaSignedUrl(
  admin: SupabaseAdminClient,
  storagePath: string,
): Promise<Uint8Array> {
  const { data, error } = await admin.storage
    .from(DOCUMENTS_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

  if (error !== null || data === null) {
    throw new Error(`Could not sign ${storagePath}: ${error?.message ?? "no signed URL returned"}`);
  }

  const response = await fetch(data.signedUrl);
  if (!response.ok) {
    // Retriable: a 5xx from Storage says nothing about the file. The URL itself cannot
    // have expired this fast, so a 4xx here is worth surfacing rather than special-casing.
    throw new Error(`Signed download of ${storagePath} returned ${response.status}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}
