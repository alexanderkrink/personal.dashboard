"use client";

import { UploadSimple } from "@phosphor-icons/react";
import {
  type DocumentKind,
  guessDocumentKind,
  MAX_DOCUMENT_LABEL,
  validateDocumentSize,
} from "@study/core";
import { useId, useRef, useState } from "react";
import { checkDuplicate, registerUpload } from "@/app/(app)/documents/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { hashFile, UploadCancelledError, uploadToStorage } from "@/lib/documents/upload";

/**
 * The upload dialog (PLAN §8 "Upload flow").
 *
 * ## Why this is not built on the shared `Form`
 *
 * Every other form in the app is a Server Action behind `useActionState`, and
 * `Form` + `FormField` exist so that pattern is written once. This is not that
 * pattern: an upload is a **multi-stage client-side flow** — size check, hash,
 * duplicate check, resumable transfer with progress, then a Server Action — and
 * most of it never touches a form submission at all. Wrapping it in `Form` would
 * mean faking an action for the sake of consistency and then fighting the
 * `useActionState` lifecycle for the progress bar.
 *
 * The one thing worth borrowing is `FormField`'s reason for existing (React 19
 * resets an uncontrolled `<form action>` once the action settles), and it does
 * not apply here because every control below is already controlled.
 *
 * ## The order of operations, which is the actual design
 *
 *   1. **size check** — locally, from `File.size`. Nothing is read, nothing is
 *      sent. This is where the 164 MB textbook stops.
 *   2. **hash** — sha256 of bytes now known to be ≤ 50 MB.
 *   3. **duplicate check** — a Server Action against `documents_dedupe`'s key,
 *      *before* the transfer. This is gate 1's finding F5: the dedupe index can
 *      otherwise reject the insert after the bytes have already landed, leaving
 *      an object no row references.
 *   4. **upload** — TUS, direct to Storage, resumable, with progress.
 *   5. **register** — the Server Action that inserts the row and sends
 *      `document/uploaded`.
 *
 * Steps 1 and 3 both exist to make step 4 not happen when it would be wasted.
 */

type Stage = "idle" | "hashing" | "uploading" | "registering";

export function UploadDialog({
  courseId,
  userId,
  onUploaded,
}: {
  courseId: string;
  userId: string;
  /** Called once a row exists, so the feed can re-read without waiting for Realtime. */
  onUploaded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<DocumentKind>("slides");
  const [deepReview, setDeepReview] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const fileInputId = useId();
  const deepReviewId = useId();

  const busy = stage !== "idle";

  function reset() {
    setFile(null);
    setStage("idle");
    setProgress(0);
    setError(null);
    setDeepReview(false);
  }

  function chooseFile(next: File | null) {
    setError(null);
    setFile(next);
    if (next === null) return;

    // The `kind` guess, per §8 — "pre-guessed from MIME type and filename". It
    // is a default, not a decision: the select below is the authority, and the
    // guess is wrong often enough (a real syllabus named
    // `marketing-fundamentals-sem1.pdf` reads as a reading) that presenting it
    // as anything firmer would be misleading.
    setKind(
      guessDocumentKind({
        filename: next.name,
        format: next.type.includes("presentation") ? "pptx" : "pdf",
      }),
    );

    // Stage 1. Local, instant, and the only thing standing between a 164 MB
    // textbook and a doomed transfer.
    const verdict = validateDocumentSize({ sizeBytes: next.size, filename: next.name });
    if (verdict !== null && !verdict.ok) setError(verdict.rejection.message);
  }

  async function submit() {
    if (file === null) return;
    setError(null);

    const verdict = validateDocumentSize({ sizeBytes: file.size, filename: file.name });
    if (verdict !== null && !verdict.ok) {
      setError(verdict.rejection.message);
      return;
    }

    // Generated HERE, before the upload, because
    // `documents_storage_path_convention` puts it inside the storage path — so
    // the id has to exist before there is anywhere to put the bytes.
    const documentId = crypto.randomUUID();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      setStage("hashing");
      const contentHash = await hashFile(file);

      const duplicate = await checkDuplicate({ courseId, contentHash });
      if (duplicate.duplicate) {
        setStage("idle");
        setError(
          `You’ve already uploaded this file to this course${
            duplicate.existingFilename ? ` as “${duplicate.existingFilename}”` : ""
          }.`,
        );
        return;
      }

      setStage("uploading");
      setProgress(0);
      await uploadToStorage({
        file,
        userId,
        courseId,
        documentId,
        signal: controller.signal,
        onProgress: setProgress,
      });

      setStage("registering");
      const result = await registerUpload({
        documentId,
        courseId,
        kind,
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        contentHash,
        deepReview,
      });

      if (!result.ok) {
        // `registerUpload` has already removed the orphaned object by the time
        // this returns — the bytes are not left behind on any failure it can
        // see. See its header comment.
        setStage("idle");
        setError(result.message);
        return;
      }

      onUploaded();
      setOpen(false);
      reset();
    } catch (cause) {
      setStage("idle");
      if (cause instanceof UploadCancelledError) return;
      setError(
        cause instanceof Error && cause.message.length < 200
          ? cause.message
          : "That upload didn’t finish. Check your connection and try again.",
      );
    } finally {
      abortRef.current = null;
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Abandoning mid-transfer aborts it rather than letting it run on
        // invisibly — otherwise the row never registers and the bytes become
        // exactly the orphan the sweep has to clean up.
        if (!next && busy) abortRef.current?.abort();
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger
        render={
          <Button>
            <UploadSimple aria-hidden className="size-4" />
            Upload
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Upload a document</DialogTitle>
          <DialogDescription>
            PDF or PowerPoint, up to {MAX_DOCUMENT_LABEL}. It goes straight to storage — large decks
            resume if the connection drops.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fileInputId}>File</Label>
            <input
              id={fileInputId}
              type="file"
              accept=".pdf,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation"
              disabled={busy}
              onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
              className="focus-ring cursor-pointer rounded-md border border-border bg-background px-3 py-2 text-ui-sm file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-ui-xs"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="upload-kind">What is it?</Label>
            <Select
              items={KIND_LABELS}
              value={kind}
              onValueChange={(value) => value && setKind(value as DocumentKind)}
            >
              <SelectTrigger id="upload-kind" className="w-full" disabled={busy}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(KIND_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Deep review — OFF by default (§8). It maps to
              `documents.deep_review = 'requested'`, which the second-reader
              audit step consumes. */}
          <div className="flex items-start gap-2.5">
            <input
              id={deepReviewId}
              type="checkbox"
              checked={deepReview}
              disabled={busy}
              onChange={(event) => setDeepReview(event.target.checked)}
              className="focus-ring mt-0.5 size-4 shrink-0 accent-accent"
            />
            <div className="min-w-0">
              <Label htmlFor={deepReviewId}>Deep review</Label>
              <p className="text-muted-foreground text-ui-xs">
                A slower second pass that re-reads the document for anything the first pass missed.
                Worth it for a dense reading; overkill for a slide deck.
              </p>
            </div>
          </div>

          {stage === "uploading" ? (
            <div className="flex flex-col gap-1.5">
              <div
                className="h-1.5 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuenow={Math.round(progress * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Upload progress"
              >
                <div
                  className="h-full rounded-full bg-accent transition-all duration-fast ease-out-quart"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
              <p className="text-muted-foreground text-ui-xs">
                Uploading… {Math.round(progress * 100)}%
              </p>
            </div>
          ) : null}

          {stage === "hashing" ? (
            <p className="text-muted-foreground text-ui-xs">Reading the file…</p>
          ) : null}
          {stage === "registering" ? (
            <p className="text-muted-foreground text-ui-xs">Filing it against the course…</p>
          ) : null}

          {error !== null ? (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-xs"
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="ghost">Cancel</Button>} />
          {/*
           * ⚠ NOT disabled on `error !== null`, and that is load-bearing.
           *
           * A `<input type="file">` fires no `change` event when the user
           * re-picks the SAME file, so `chooseFile` — the only other place that
           * clears `error` — never runs on a retry of the file that just
           * failed. Disabling here therefore made every error terminal: the
           * sole escape was closing the dialog, measured at gate 3.
           *
           * That mattered most for the failure this flow is *built* around. TUS
           * was chosen for resumability on a lecture-hall connection, and a
           * dropped transfer lands in the `catch` below with the file still
           * selected — precisely when `upload.findPreviousUploads()` would
           * resume from the last checkpoint. Disabling the button put that
           * behind a dialog reopen, which discards the state and restarts at 0.
           *
           * Nothing is lost by allowing the click: `submit()` clears `error`
           * and re-runs `validateDocumentSize` first, so an oversized file
           * simply re-shows its message without transferring a byte.
           */}
          <Button onClick={() => void submit()} disabled={file === null || busy}>
            {busy ? "Working…" : "Upload"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const KIND_LABELS: Record<DocumentKind, string> = {
  slides: "Lecture slides",
  reading: "Reading",
  case: "Case",
  syllabus: "Syllabus",
};
