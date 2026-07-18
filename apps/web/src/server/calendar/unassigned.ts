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
