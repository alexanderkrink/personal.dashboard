"use client";

import { ArrowCounterClockwise, ClockCounterClockwise, Warning } from "@phosphor-icons/react";
import { diffCountLabel, diffTopicPages, type TopicPageDiff } from "@study/core";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { revertTopicRevision } from "@/app/(app)/courses/[id]/topics/[slug]/actions";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/**
 * §8's History drawer: revisions labelled by source, each with view-diff and revert.
 *
 * ## The empty state is the most important thing in this file
 *
 * 🔴 **Verified live 2026-07-20: `topic_revisions` holds ZERO rows for the one topic that
 * exists, despite `topics.revision = 1`.** The merge *create* path in
 * `apps/web/src/inngest/route-and-merge.ts` inserts the topic row and never writes a
 * revision snapshot; only the *update* path does. So a topic's first version — the one a
 * model generated whole, out of material nobody has checked — has no history at all.
 *
 * Rendering that as an empty list would be the same class of failure this whole wave exists
 * to kill: a silent nothing that reads as "nothing happened" when what actually happened is
 * that a language model wrote the entire page and no snapshot was kept. So the drawer says
 * it in words, and says what the consequence is (there is nothing to revert *to*).
 *
 * The honest fix is upstream — the create path should write a revision row against the
 * empty page — and that is a pipeline change, not a UI change. This states the gap until
 * someone makes it.
 */

export interface HistoryRevision {
  readonly id: string;
  readonly revision: number;
  readonly headline: string;
  readonly changeSummary: string;
  readonly source: string;
  readonly needsReview: boolean;
  readonly createdAt: string;
  readonly promptId: string;
  readonly promptVersion: number;
  readonly model: string;
  /** This revision's snapshot — the page as it was BEFORE the merge that created the row. */
  readonly page: unknown;
}

export function HistoryDrawer({
  topicId,
  courseId,
  slug,
  revisions,
  currentPage,
  currentRevision,
}: {
  topicId: string;
  courseId: string;
  slug: string;
  revisions: readonly HistoryRevision[];
  currentPage: unknown;
  currentRevision: number;
}) {
  return (
    <Sheet>
      <SheetTrigger
        render={
          <Button size="sm" variant="outline">
            <ClockCounterClockwise aria-hidden className="size-3.5" />
            History
          </Button>
        }
      />
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Revision history</SheetTitle>
          <SheetDescription>
            Every merge, deep-review edit and revert that changed this page.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-3 px-4 pb-6">
          {revisions.length === 0 ? (
            <NoHistoryRecorded revision={currentRevision} />
          ) : (
            revisions.map((revision, index) => (
              <RevisionRow
                courseId={courseId}
                key={revision.id}
                /*
                 * A revision's snapshot is the page BEFORE its merge, so what that merge
                 * *did* is the diff against whatever came next — the previous row in this
                 * descending list, or the live page for the newest one.
                 */
                next={index === 0 ? currentPage : revisions[index - 1]?.page}
                revision={revision}
                slug={slug}
                topicId={topicId}
              />
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * The state PLAN did not anticipate and the database is currently always in for a new
 * topic. Never an empty list — see the module note.
 */
function NoHistoryRecorded({ revision }: { revision: number }) {
  return (
    <div
      className="space-y-2 rounded-md border border-warning/40 bg-warning/8 p-3 text-ui-sm text-warning"
      data-testid="no-history"
    >
      <p className="flex items-center gap-1.5 font-semibold">
        <Warning aria-hidden className="size-4" weight="fill" />
        No history was recorded for this page
      </p>
      <p>
        {`This topic is on revision ${revision}, but no snapshot exists for how it got there. The pipeline writes a revision row when a later document changes a page — it does not write one when the page is first created, so a first version has nothing behind it.`}
      </p>
      <p>There is nothing to compare against and nothing to revert to.</p>
    </div>
  );
}

function RevisionRow({
  revision,
  next,
  topicId,
  courseId,
  slug,
}: {
  revision: HistoryRevision;
  next: unknown;
  topicId: string;
  courseId: string;
  slug: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const diff =
    next === undefined
      ? null
      : diffTopicPages(
          (revision.page ?? {}) as Parameters<typeof diffTopicPages>[0],
          (next ?? {}) as Parameters<typeof diffTopicPages>[1],
        );

  function revert() {
    startTransition(async () => {
      const result = await revertTopicRevision({
        topicId,
        revisionId: revision.id,
        courseId,
        slug,
      });
      if (result.ok) toast.success(result.message ?? "Reverted.");
      else toast.error(result.message ?? "That revert didn’t go through.");
    });
  }

  return (
    <div
      className={cn(
        "rounded-md border p-3 text-ui-sm",
        revision.needsReview ? "border-warning/40 bg-warning/8" : "border-border",
      )}
      data-needs-review={revision.needsReview ? "true" : "false"}
      data-testid="revision-row"
    >
      <p className={cn("font-semibold", revision.needsReview ? "text-warning" : "text-foreground")}>
        {revision.headline}
      </p>
      <p className="mt-1 text-muted-foreground">{revision.changeSummary}</p>

      <p className="mt-1 font-mono text-muted-foreground text-ui-xs">
        {`r${revision.revision} · ${new Date(revision.createdAt).toLocaleString()} · ${revision.promptId}@v${revision.promptVersion} · ${revision.model}`}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button onClick={() => setOpen((v) => !v)} size="sm" variant="ghost">
          {open ? "Hide diff" : "View diff"}
        </Button>
        <Button disabled={pending} onClick={revert} size="sm" variant="ghost">
          <ArrowCounterClockwise aria-hidden className="size-3.5" />
          {pending ? "Reverting…" : "Revert to this"}
        </Button>
        {diff === null ? null : (
          <span className="font-mono text-muted-foreground text-ui-xs">
            {diffCountLabel(diff) ?? "no block changes"}
          </span>
        )}
      </div>

      {open && diff !== null ? <DiffList diff={diff} /> : null}
    </div>
  );
}

/**
 * Block-level diff. Losses first — a revision that dropped something is what a student
 * needs to see before deciding whether to revert, and burying it under unchanged rows is
 * how it gets missed.
 */
function DiffList({ diff }: { diff: TopicPageDiff }) {
  const shown = diff.entries.filter((entry) => entry.status !== "unchanged");

  return (
    <div className="mt-2 space-y-1 border-border border-t pt-2" data-testid="diff">
      {diff.summaryChanged ? (
        <p className="font-mono text-ui-xs">
          <span className="text-muted-foreground">summary</span> rewritten
        </p>
      ) : null}
      {shown.length === 0 && !diff.summaryChanged ? (
        <p className="text-muted-foreground text-ui-xs">
          No block changed. This revision only restated the page.
        </p>
      ) : null}
      {shown.map((entry) => (
        <p className="font-mono text-ui-xs" key={entry.key}>
          <span
            className={cn(
              "mr-2 inline-block w-16",
              entry.status === "removed" && "text-danger",
              entry.status === "added" && "text-success",
              entry.status === "changed" && "text-muted-foreground",
            )}
          >
            {entry.status}
          </span>
          <span className="text-muted-foreground">{entry.kind}</span> {entry.label}
        </p>
      ))}
      {diff.unchanged > 0 ? (
        <p className="text-muted-foreground text-ui-xs">{`${diff.unchanged} block${diff.unchanged === 1 ? "" : "s"} unchanged.`}</p>
      ) : null}
    </div>
  );
}
