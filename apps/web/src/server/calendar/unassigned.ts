/**
 * The Unassigned bucket (§5.1 step 4), grouped by course-name pattern.
 *
 * ⚠ **On the live database this bucket holds 220 rows.** §5.1 says surface it at
 * the top of the calendar page; 220 individual rows there is not a bucket, it is
 * a wall, and it would push the actual deadlines below the fold on every screen
 * size. They are also not 220 unrelated problems — they are **15 course-name
 * patterns**, almost all of them 2025/26 spring courses that were never seeded
 * (`FINANCE LAB` ×32, `FUNDAMENTALS OF DATA ANALYSIS` ×32, …).
 *
 * So the bucket groups by the hint that failed to match. That turns the wall
 * into fifteen rows, and — because assigning writes a `course_matchers` row from
 * exactly this pattern — **one click files an entire course's events at once and
 * keeps filing them forever after**. Assigning 220 events individually would be
 * the same 220 clicks that made the un-grouped list unusable.
 *
 * The hint comes from `normalizeSummary`, the same function the sync path
 * matches on, so the group label is literally the string a matcher will be
 * created from. A separate "close enough" grouping here would let a user assign
 * a pattern that then fails to match anything.
 */

import { classifyPseudoRow, normalizeSummary } from "@study/core";

export interface UnassignedItem {
  id: string;
  raw_summary: string | null;
  title: string;
  starts_at: string;
}

export interface UnassignedGroup {
  /** The course hint — and the exact `course_matchers.pattern` an assign writes. */
  pattern: string;
  count: number;
  /** `calendar_items.id`s in this group, so one action can update them all. */
  itemIds: string[];
  firstStartsAt: string;
  lastStartsAt: string;
}

/**
 * Groups unmatched items by their course hint, biggest group first.
 *
 * Rows whose summary the normalizer rejects outright — the 5 pseudo/LMS rows —
 * are dropped rather than grouped under an empty pattern. Two of them carry a
 * real course prefix, so they would otherwise appear as offers to assign a
 * proctoring check to a course.
 */
export function groupUnassigned(items: readonly UnassignedItem[]): UnassignedGroup[] {
  const groups = new Map<string, UnassignedGroup>();

  for (const item of items) {
    const raw = item.raw_summary ?? "";
    if (classifyPseudoRow(raw) !== null) continue;

    const summary = normalizeSummary(raw);
    // Fall back to the stored title so a feed with no course prefix at all still
    // produces something assignable rather than vanishing from the bucket.
    const pattern = (summary?.courseName ?? item.title).trim();
    if (pattern === "") continue;

    const existing = groups.get(pattern);
    if (existing) {
      existing.count += 1;
      existing.itemIds.push(item.id);
      if (item.starts_at < existing.firstStartsAt) existing.firstStartsAt = item.starts_at;
      if (item.starts_at > existing.lastStartsAt) existing.lastStartsAt = item.starts_at;
    } else {
      groups.set(pattern, {
        pattern,
        count: 1,
        itemIds: [item.id],
        firstStartsAt: item.starts_at,
        lastStartsAt: item.starts_at,
      });
    }
  }

  return [...groups.values()].sort(
    (a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern),
  );
}

export interface PartitionedUnassigned {
  /** Groups with something still to come. These are worth a decision now. */
  actionable: UnassignedGroup[];
  /** Groups entirely in the past. Real, keepable, and not urgent. */
  historical: UnassignedGroup[];
}

/**
 * Splits the bucket into *"decide this"* and *"this already happened"*.
 *
 * ## Why this exists (2026-07-19)
 *
 * ⚠ **All 217 unmatched items are in the past** — every one belongs to 2025/26
 * spring, a term that ended and that Alexander has decided will never get a
 * `semesters` row. So the bucket's collapsed one-liner said *"217 across 15
 * courses"* permanently, at the top of the calendar page, about work that
 * finished in June and can never become urgent again.
 *
 * That is worse than clutter. The bucket's whole justification is that it is
 * **actionable**: it exists so an unmatched event gets filed and stops being
 * invisible. A count that never goes down and never matters teaches the reader
 * to skip the bucket — and then it will be skipped on the day it finally
 * carries something from this term.
 *
 * So the partition is by *"can this still affect me"*, and the historical side
 * is demoted rather than deleted. **No rows are removed** — this is a display
 * decision. The history stays reachable for two concrete reasons:
 *
 * 1. Filing a pattern writes a `course_matchers` row, so filing a finished
 *    course is still how its *future* repeats auto-link.
 * 2. 217 rows that no surface renders are 217 rows nobody can ever find, which
 *    is the failure mode the bucket was built to prevent.
 *
 * A group counts as actionable if **anything in it is still to come**. Keyed on
 * `lastStartsAt`, not `firstStartsAt`: a course running Jan→Dec is a live
 * concern in July, and keying on its first event would file it under history.
 */
export function partitionUnassigned(
  groups: readonly UnassignedGroup[],
  now: Date,
): PartitionedUnassigned {
  const at = now.toISOString();
  const actionable: UnassignedGroup[] = [];
  const historical: UnassignedGroup[] = [];

  for (const group of groups) {
    (group.lastStartsAt >= at ? actionable : historical).push(group);
  }

  return { actionable, historical };
}

/** Total events across a set of groups — what the collapsed line counts. */
export function countUnassigned(groups: readonly UnassignedGroup[]): number {
  return groups.reduce((count, group) => count + group.count, 0);
}
