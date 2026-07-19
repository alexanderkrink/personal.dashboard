"use client";

import {
  ArrowClockwise,
  CheckCircle,
  Eye,
  FilePdf,
  FilePpt,
  TextAlignLeft,
  Trash,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { formatBytes } from "@study/core";
import { useTransition } from "react";
import { deleteDocument, retryDocument } from "@/app/(app)/documents/actions";
import { Button } from "@/components/ui/button";
import type { DocumentRow, ProcessingEventRow } from "@/lib/documents/use-document-feed";
import { cn } from "@/lib/utils";

/**
 * One document's status card (PLAN §8 "Status tracking & UX").
 *
 * Three shapes, and which one shows is decided entirely by `documents.status`:
 * a **running** card walking a step checklist with the pulsing dot on the active
 * step; a **ready** card collapsed to a summary; a **failed** card carrying a
 * sentence and two actions.
 */

/**
 * The step checklist.
 *
 * ## Why this list is short, and why that is honest
 *
 * PLAN §8 specifies the full walk — *Validating → Converting → Extracting →
 * Organizing into topics → Verifying changes → Indexing for search → Checking
 * coverage → Extracting terms → Done* — as one of "four views of one step list",
 * to be changed together with the §1 flow, the §3 sketch and the architecture
 * diagram.
 *
 * The pipeline currently runs `validate → finalize`. Rendering the other seven
 * steps today would draw a checklist where most rows can never light up, which
 * does not read as "coming soon" — it reads as a stuck job, on the one screen
 * whose entire purpose is telling the user whether the job is stuck. So the
 * checklist lists what the pipeline can actually reach, and grows as the steps
 * land.
 *
 * ⚠ **Adding a step means adding it in all four places**, plus here. The
 * `status` values are already in the `document_status` enum, so a new entry is
 * one line: `{ status: "extracting", label: "Extracting" }` in the right slot.
 */
const CHECKLIST: ReadonlyArray<{ status: string; label: string }> = [
  { status: "queued", label: "Queued" },
  { status: "validating", label: "Checking the file" },
  { status: "extracting", label: "Reading the pages" },
  // structuring / merging / embedding attach HERE, in enum order, as their
  // steps land.
  { status: "ready", label: "Done" },
];

const TERMINAL = new Set(["ready", "partial", "failed"]);

/** Where a status sits in the walk. `-1` for terminal states off the happy path. */
function checklistIndex(status: string): number {
  return CHECKLIST.findIndex((entry) => entry.status === status);
}

function FormatIcon({ mimeType }: { mimeType: string }) {
  const Icon = mimeType.includes("presentation") ? FilePpt : FilePdf;
  return <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" weight="duotone" />;
}

export function DocumentCard({
  document,
  events,
}: {
  document: DocumentRow;
  events: readonly ProcessingEventRow[];
}) {
  const [pending, startTransition] = useTransition();

  const mine = events.filter((event) => event.document_id === document.id);
  const lastLine = mine.at(-1);
  const activeIndex = checklistIndex(document.status);
  const running = !TERMINAL.has(document.status);

  return (
    <li
      className="rounded-lg border border-border bg-surface p-4"
      // The card is a live region while it is working, so a screen-reader user
      // hears the step change without having to go looking for it. Terminal
      // cards drop out of the live region — the change has already been
      // announced, and re-announcing a settled card on every re-render is noise.
      aria-live={running ? "polite" : "off"}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <FormatIcon mimeType={document.mime_type} />
          <div className="min-w-0">
            <p className="truncate font-medium text-ui-sm">{document.filename}</p>
            <p className="text-muted-foreground text-ui-xs">
              {KIND_LABELS[document.kind] ?? document.kind} · {formatBytes(document.size_bytes)}
              {document.deep_review !== "off" ? " · Deep review" : ""}
            </p>
          </div>
        </div>

        {document.status === "ready" ? (
          <span className="flex shrink-0 items-center gap-1 text-success text-ui-xs">
            <CheckCircle aria-hidden className="size-4" weight="fill" />
            Ready
          </span>
        ) : null}
      </div>

      {/* ── Running: the step checklist ─────────────────────────────────── */}
      {running ? (
        <ol className="mt-3 flex flex-col gap-1.5">
          {CHECKLIST.map((entry, index) => {
            const done = activeIndex > index;
            const active = activeIndex === index;
            return (
              <li
                key={entry.status}
                className={cn(
                  "flex items-center gap-2 text-ui-xs",
                  active ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {done ? (
                  <CheckCircle aria-hidden className="size-3.5 text-success" weight="fill" />
                ) : (
                  <span
                    aria-hidden
                    className={cn(
                      "dot-motif",
                      active && "dot-motif-pulse",
                      !active && "opacity-40",
                    )}
                  />
                )}
                <span>{entry.label}</span>
              </li>
            );
          })}
        </ol>
      ) : null}

      {/* The newest feed line, verbatim. This is what the pipeline actually
          said, as opposed to what the checklist infers from the status. */}
      {running && lastLine?.detail ? (
        <p className="mt-2 text-muted-foreground text-ui-xs">{lastLine.detail}</p>
      ) : null}

      {/* ── partial: the amber retry banner (§8) ────────────────────────── */}
      {document.status === "partial" ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2">
          <WarningCircle aria-hidden className="size-4 shrink-0 text-warning" weight="fill" />
          <p className="min-w-0 flex-1 text-ui-xs">
            {document.failure_reason ?? "Some of this document didn’t finish processing."}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => startTransition(() => void retryDocument({ documentId: document.id }))}
          >
            <ArrowClockwise aria-hidden className="size-3.5" />
            Retry the rest
          </Button>
        </div>
      ) : null}

      {/* ── failed: a sentence, never a stack trace (§8) ─────────────────── */}
      {document.status === "failed" ? (
        <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">
          <div className="flex items-start gap-2">
            <XCircle
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-destructive"
              weight="fill"
            />
            <p className="min-w-0 flex-1 text-ui-xs">
              {/* `failure_reason` is written either by the step that knew the
                  human reason or by `onFailure`'s generic fallback — never from
                  a serialized error. The `??` here is for a row that failed
                  before either could write, not a place to put error text. */}
              {document.failure_reason ??
                "This file couldn’t be processed. Try uploading it again."}
            </p>
          </div>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => startTransition(() => void retryDocument({ documentId: document.id }))}
            >
              <ArrowClockwise aria-hidden className="size-3.5" />
              Try again
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                startTransition(() => void deleteDocument({ documentId: document.id }))
              }
            >
              <Trash aria-hidden className="size-3.5" />
              Delete
            </Button>
          </div>
        </div>
      ) : null}

      {/* ── ready: collapsed to a summary (§8) ──────────────────────────── */}
      {document.status === "ready" ? (
        <div className="mt-2 flex flex-col gap-1">
          <p className="text-muted-foreground text-ui-xs">
            {/* §8's summary line is "Contributed to 4 topics" plus a coverage
                line. Both are computed by steps that do not exist yet, so this
                says the true thing instead of a placeholder shaped like the
                eventual one. */}
            Read and stored. Topic extraction lands with the next pipeline steps.
          </p>
          <FidelityNote fidelity={document.extraction_fidelity} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * "Why does this page look thin?" — `documents.extraction_fidelity`, explained.
 *
 * PLAN's 🔴 measured block of 2026-07-18 is explicit that this "stops being a rarely-used
 * field and becomes a routine UI state, so the explanation must be built, not stubbed."
 * The corpus bears that out: four of five Marketing decks take the visual path and three
 * of three Micro decks take the text path, so within one semester a user sees both, on
 * documents that look identical in the list.
 *
 * The two cases genuinely need different sentences, and neither is an error:
 *
 *  - **`visual`** — the document was *seen*: a native PDF, or a picture-heavy deck we
 *    converted to PDF first. Diagrams and charts were read. This is the good case and it
 *    says so briefly, because a reassurance nobody needed is still clutter.
 *  - **`text-only`** — the deck's own text was rich enough that its images were not worth
 *    the conversion, so figures were *not* read. That is the state that produces a thinner
 *    topic page than the user expects, and it is the one this component exists for. It
 *    names the cause and the remedy rather than apologising.
 *
 * A `null` renders nothing: an older document processed before this field existed has no
 * honest answer, and inventing one would be worse than staying quiet.
 */
function FidelityNote({ fidelity }: { fidelity: string | null }) {
  if (fidelity === "visual") {
    return (
      <p className="text-muted-foreground text-ui-xs">
        <Eye aria-hidden className="mr-1 inline size-3.5 align-[-2px]" />
        Read visually — diagrams, charts and equations on the pages were included.
      </p>
    );
  }

  if (fidelity === "text-only") {
    return (
      <p className="text-muted-foreground text-ui-xs">
        <TextAlignLeft aria-hidden className="mr-1 inline size-3.5 align-[-2px]" />
        Read from the deck’s text, which was detailed enough not to need the images. Anything that
        only appears inside a diagram or a screenshot won’t be in the notes — re-upload it as a PDF
        if a figure matters.
      </p>
    );
  }

  return null;
}

const KIND_LABELS: Readonly<Record<string, string>> = {
  slides: "Slides",
  reading: "Reading",
  case: "Case",
  syllabus: "Syllabus",
  other: "Document",
};
