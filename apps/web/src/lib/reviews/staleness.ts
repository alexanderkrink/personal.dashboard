/**
 * The exam-review staleness banner's arithmetic (PLAN §9: *"the UI shows 'Based on materials
 * through Lecture 9 — 2 topics changed since' with a Regenerate button"*).
 *
 * Pure and separate from the route for the same reason the topic view model is: "how many
 * topics changed since this review was built" is a judgement worth a test, and a Server
 * Component that awaited Supabase could not have one. The route fetches; this counts.
 */

/** One `(topicId, revision)` pair from a review's `topic_snapshot`, already parsed. */
export interface SnapshotPair {
  readonly topicId: string;
  readonly revision: number;
}

/**
 * How many of a review's topics have changed since it was built.
 *
 * A topic counts as changed when its revision has moved forward (its page was edited) or it has
 * disappeared (deleted or merged away). A **new** topic the review never covered does NOT count
 * — a review has not decayed because the course grew, and counting growth as decay would make
 * the banner cry stale on every upload forever. This mirrors `isReviewStale` exactly; it just
 * returns the count the banner needs instead of a boolean.
 *
 * A `null` snapshot (unreadable) returns `0`: the count is unknown, so the banner leans on the
 * stored `stale` flag rather than inventing a number.
 */
export function countChangedTopics(
  snapshot: readonly SnapshotPair[] | null,
  current: ReadonlyMap<string, number>,
): number {
  if (snapshot === null) return 0;

  let changed = 0;
  for (const pair of snapshot) {
    const revision = current.get(pair.topicId);
    if (revision === undefined || revision > pair.revision) changed += 1;
  }
  return changed;
}

/** A document as the banner sees it — just its label and when it landed. */
export interface DatedDocument {
  readonly sessionLabel: string | null;
  readonly createdAt: string;
  readonly filename: string;
}

/**
 * The "materials through …" label: the newest document's session label, or its filename when it
 * never got one. `null` when the course has no documents (a review with nothing behind it).
 */
export function materialsThrough(documents: readonly DatedDocument[]): string | null {
  if (documents.length === 0) return null;
  const newest = [...documents].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (newest === undefined) return null;
  const label = (newest.sessionLabel ?? "").trim();
  return label === "" ? newest.filename : label;
}
