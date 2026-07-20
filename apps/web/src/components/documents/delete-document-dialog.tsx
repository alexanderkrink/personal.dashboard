"use client";

import { Trash, WarningCircle } from "@phosphor-icons/react";
import { useState, useTransition } from "react";
import {
  type DeleteImpact,
  deleteDocument,
  previewDocumentDelete,
} from "@/app/(app)/documents/actions";
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

/**
 * The *Delete* affordance and its confirmation (PLAN §8).
 *
 * ## Why this is a dialog and not a one-click button
 *
 * The delete is destructive, irreversible, and — since the strip landed — reaches
 * further than the file it names: it can remove whole topics and rewrite the pages
 * of others. A button that did that silently would be indefensible, so the dialog
 * states the consequence in counted nouns before the user commits.
 *
 * ## Why it states what the delete does NOT do
 *
 * The strip removes every block it can attribute to this document. Two things
 * carry no provenance and therefore survive: a co-authored topic's `summary`
 * paragraph, and any block whose sources name no document. `previewDocumentDelete`
 * counts both, and this dialog says so in the same breath as the removals.
 *
 * A confirmation that overstated its reach — "this removes the document and
 * everything it contributed" — would be a lie in exactly the case the user cares
 * about most, which is the topic they share with another deck. The rule is that
 * the copy tracks the measurement: the numbers here come from the same
 * `planDocumentStrip` call that the delete itself will run.
 */
export function DeleteDocumentDialog({
  documentId,
  filename,
  onDeleted,
}: {
  documentId: string;
  filename: string;
  onDeleted?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [impact, setImpact] = useState<DeleteImpact | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /**
   * The preview is fetched when the dialog opens rather than with the card, because
   * a documents page holding a dozen cards would otherwise run a dozen multi-table
   * plans nobody asked for. The cost lands on the one document being deleted.
   */
  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setFailed(null);
      return;
    }

    setImpact(null);
    setLoading(true);
    void previewDocumentDelete({ documentId })
      .then(setImpact)
      .finally(() => setLoading(false));
  }

  function handleDelete() {
    setFailed(null);
    startTransition(async () => {
      const result = await deleteDocument({ documentId });
      if (!result.ok) {
        setFailed(result.message ?? "That didn’t delete. Try again.");
        return;
      }
      setOpen(false);
      onDeleted?.();
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* Base UI: the trigger takes `render`, never Radix's `asChild`. Going through
          the real trigger rather than a bare button is what returns focus here when
          the dialog closes. */}
      <DialogTrigger
        render={
          <Button size="sm" variant="ghost">
            <Trash aria-hidden className="size-3.5" />
            Delete
          </Button>
        }
      />

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete “{filename}”?</DialogTitle>
          <DialogDescription>This can’t be undone.</DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="text-muted-foreground text-ui-sm">Working out what this affects…</p>
        ) : null}

        {impact ? <ImpactSummary impact={impact} /> : null}

        {!loading && impact === null ? (
          <p className="text-muted-foreground text-ui-sm">
            Couldn’t check what this affects. Deleting will still remove the file, its search index
            and its links to your topics.
          </p>
        ) : null}

        {failed ? (
          <p className="flex items-start gap-2 text-destructive text-ui-sm">
            <WarningCircle aria-hidden className="mt-0.5 size-4 shrink-0" weight="fill" />
            {failed}
          </p>
        ) : null}

        <DialogFooter>
          <DialogClose
            render={
              <Button variant="outline" disabled={pending}>
                Keep it
              </Button>
            }
          />
          <Button variant="destructive" disabled={pending || loading} onClick={handleDelete}>
            <Trash aria-hidden className="size-3.5" />
            {pending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** `n thing` / `n things`, because every line here is a count. */
function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The consequence, in two halves: what goes, and what stays.
 *
 * The second half is not a disclaimer — it is the part that keeps the first half
 * honest, and it renders with the same weight rather than as fine print.
 */
function ImpactSummary({ impact }: { impact: DeleteImpact }) {
  const stays: string[] = [];
  if (impact.staleSummaries > 0) {
    stays.push(
      `the summary paragraph on ${plural(impact.staleSummaries, "topic", "topics")} you built with other files — it may still describe what’s being removed`,
    );
  }
  if (impact.blocksUnattributed > 0) {
    stays.push(
      `${plural(impact.blocksUnattributed, "note", "notes")} that don’t say which file they came from`,
    );
  }

  return (
    <div className="flex flex-col gap-3 text-ui-sm">
      <div>
        <p className="font-medium">This removes</p>
        <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4 text-muted-foreground">
          <li>the uploaded file and everything read from it</li>
          {impact.chunks > 0 ? (
            <li>{plural(impact.chunks, "search passage", "search passages")}</li>
          ) : null}
          {impact.topicsRemoved.length > 0 ? (
            <li>
              <span className="text-foreground">
                {plural(impact.topicsRemoved.length, "whole topic", "whole topics")}
              </span>{" "}
              built only from this file — {impact.topicsRemoved.join(", ")}
            </li>
          ) : null}
          {impact.blocksRemoved > 0 ? (
            <li>
              {plural(impact.blocksRemoved, "note", "notes")} from{" "}
              {plural(impact.topicsRewritten.length, "topic", "topics")} you also built with other
              files — {impact.topicsRewritten.join(", ")}
            </li>
          ) : null}
        </ul>
      </div>

      {stays.length > 0 ? (
        <div>
          <p className="font-medium">This leaves behind</p>
          <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4 text-muted-foreground">
            {stays.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {impact.topicsRemoved.length === 0 &&
      impact.blocksRemoved === 0 &&
      impact.topicsRewritten.length === 0 ? (
        <p className="text-muted-foreground">
          No topic pages change — this file hasn’t been merged into any of them.
        </p>
      ) : null}

      <p className="text-muted-foreground text-ui-xs">
        You can upload this file again afterwards and it will be processed from scratch.
      </p>
    </div>
  );
}
