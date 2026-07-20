/**
 * Block-level diff between two TopicPage snapshots, for the History drawer's "view diff".
 *
 * `topic_revisions.page` holds the page **before** a merge applied, so the diff a person
 * wants to see for revision N is `revisions[N].page` against whatever came next — the next
 * revision's snapshot, or the live page for the most recent one. This module answers that
 * comparison and nothing else.
 *
 * It reuses {@link flattenTopicPage}'s identity keys rather than inventing a second notion
 * of block identity. That matters: the loss-detector already decides what "the same block,
 * edited" means, and a history drawer that disagreed with it would show a student a
 * deletion that the pipeline's own safety check considered an edit. One definition, two
 * consumers.
 *
 * Deliberately **not** a text diff. Rendering word-level changes inside a markdown block is
 * a different and much larger problem, and the question the drawer exists to answer is
 * "what did lecture 7 change?" — which is answered by naming the blocks, not by painting
 * every reworded sentence. `changed` carries both texts so a consumer can render them side
 * by side if it wants to.
 */

import { type BlockKind, flattenTopicPage, type TopicPageLike } from "./page";

export type DiffStatus = "added" | "removed" | "changed" | "unchanged";

export interface TopicPageDiffEntry {
  readonly key: string;
  readonly kind: BlockKind;
  readonly label: string;
  readonly status: DiffStatus;
  /** The block's text before, or null when it was added. */
  readonly before: string | null;
  /** The block's text after, or null when it was removed. */
  readonly after: string | null;
}

export interface TopicPageDiff {
  readonly entries: readonly TopicPageDiffEntry[];
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly summaryChanged: boolean;
  /** True when the two snapshots are indistinguishable at block level and in summary. */
  readonly identical: boolean;
}

/**
 * Diffs two snapshots by block identity.
 *
 * Order is `removed`, then `changed`, then `added`, then `unchanged` — losses first,
 * because a revision that dropped something is the one a student needs to see before they
 * decide whether to revert, and burying it under twelve unchanged rows is how it gets
 * missed.
 */
export function diffTopicPages(before: TopicPageLike, after: TopicPageLike): TopicPageDiff {
  const beforeBlocks = new Map(flattenTopicPage(before).map((b) => [b.key, b]));
  const afterBlocks = new Map(flattenTopicPage(after).map((b) => [b.key, b]));

  const entries: TopicPageDiffEntry[] = [];

  for (const [key, block] of beforeBlocks) {
    const next = afterBlocks.get(key);
    if (next === undefined) {
      entries.push({
        key,
        kind: block.kind,
        label: block.label,
        status: "removed",
        before: block.text,
        after: null,
      });
      continue;
    }
    entries.push({
      key,
      kind: block.kind,
      label: next.label,
      status: next.text === block.text ? "unchanged" : "changed",
      before: block.text,
      after: next.text,
    });
  }

  for (const [key, block] of afterBlocks) {
    if (beforeBlocks.has(key)) continue;
    entries.push({
      key,
      kind: block.kind,
      label: block.label,
      status: "added",
      before: null,
      after: block.text,
    });
  }

  const ORDER: Record<DiffStatus, number> = { removed: 0, changed: 1, added: 2, unchanged: 3 };
  entries.sort((a, b) => ORDER[a.status] - ORDER[b.status]);

  const count = (status: DiffStatus) => entries.filter((e) => e.status === status).length;
  const added = count("added");
  const removed = count("removed");
  const changed = count("changed");
  const summaryChanged = (before.summary ?? "").trim() !== (after.summary ?? "").trim();

  return {
    entries,
    added,
    removed,
    changed,
    unchanged: count("unchanged"),
    summaryChanged,
    identical: added === 0 && removed === 0 && changed === 0 && !summaryChanged,
  };
}

/**
 * A one-line count for a drawer row — "2 added · 1 removed".
 *
 * Returns null when nothing changed, so a caller can distinguish "no differences" from
 * "0 added · 0 removed", which reads as a bug.
 */
export function diffCountLabel(diff: TopicPageDiff): string | null {
  const parts: string[] = [];
  if (diff.added > 0) parts.push(`${diff.added} added`);
  if (diff.changed > 0) parts.push(`${diff.changed} rewritten`);
  if (diff.removed > 0) parts.push(`${diff.removed} removed`);
  if (diff.summaryChanged && parts.length === 0) return "summary rewritten";
  if (parts.length === 0) return null;
  return parts.join(" · ");
}
