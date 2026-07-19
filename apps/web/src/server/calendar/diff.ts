/**
 * The pure decision layer of the sync engine (§3.2 row diff, §3.3 lifecycle,
 * §3.6 cancellations).
 *
 * Everything here is a pure function over plain data: no Supabase, no clock, no
 * `Date.now()` — `nowIso` is always a parameter. That is deliberate. The
 * tombstone flow is the highest-risk correctness path in this feature, because
 * the IE feed emits **zero** `STATUS:CANCELLED` (379/379 CONFIRMED, verified
 * 2026-07-18): a cancelled lecture simply vanishes, so this diff is the only
 * thing standing between "the professor cancelled Thursday" and "Thursday
 * silently disappeared, along with the fact that it was ever there". Making the
 * decisions pure is what lets them be tested exhaustively without a database.
 *
 * It does NOT live in `packages/core`, despite being pure, because it is
 * expressed in this application's persisted row shapes (`calendar_items`
 * columns, `user_locked_fields`). Core owns the parsing; the shape of our
 * tables is ours.
 */

import type { NormalizedEvent, NormalizedOccurrence } from "@study/core";

/* -------------------------------------------------------------------------- */
/* Grace periods                                                              */
/* -------------------------------------------------------------------------- */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long a vanished item stays fully visible before it is treated as
 * cancelled (§3.3). ICS feeds are windowed and occasionally truncated, so a
 * single bad generation upstream must not wipe the calendar.
 */
export const TOMBSTONE_HIDE_AFTER_MS = 24 * HOUR_MS;

/** How long a vanished item survives before it is actually deleted (§3.3). */
export const TOMBSTONE_DELETE_AFTER_MS = 7 * DAY_MS;

/** How long a cancelled occurrence is rendered struck through before it is hidden (§3.6). */
export const CANCELLED_VISIBLE_MS = 7 * DAY_MS;

/* -------------------------------------------------------------------------- */
/* Field ownership and locking                                                */
/* -------------------------------------------------------------------------- */

/**
 * Columns on `calendar_items` that a sync writes from feed data.
 *
 * Anything not on this list is ours or the user's and is never touched by a
 * sync — `completed_at`, `weight_override`, `created_at`, and the identity
 * columns themselves.
 */
export const SYNCED_ITEM_FIELDS = [
  "title",
  "kind",
  "raw_summary",
  "description",
  "location",
  "rrule",
  "original_tzid",
  "sequence",
  "session_from",
  "session_to",
  "descriptor",
  "course_id",
] as const;

export type SyncedItemField = (typeof SYNCED_ITEM_FIELDS)[number];

/**
 * Columns the user may take ownership of.
 *
 * A superset of `SYNCED_ITEM_FIELDS`: `hidden`, `is_exam_candidate` and
 * `weight_override` are written by the engine's own derivation (retake hiding,
 * §5.1b exam detection) rather than copied from the feed, but a user override
 * has to win over a derivation exactly as it wins over a feed value.
 *
 * A field name that is not on this list is rejected when locking, so a typo
 * cannot create a lock that silently protects nothing.
 */
export const LOCKABLE_ITEM_FIELDS = [
  ...SYNCED_ITEM_FIELDS,
  "assessment_id",
  "hidden",
  "is_exam_candidate",
  "weight_override",
] as const;

export type LockableItemField = (typeof LOCKABLE_ITEM_FIELDS)[number];

const LOCKABLE = new Set<string>(LOCKABLE_ITEM_FIELDS);

export function isLockableItemField(field: string): field is LockableItemField {
  return LOCKABLE.has(field);
}

/**
 * Drops every locked key from an update payload (§3.3).
 *
 * The single rule this enforces: **if the user edited it, sync never writes it
 * again.** Not "writes it unless the feed changed", not "writes it if the
 * SEQUENCE bumped" — never. A user who renames an event and finds the feed's
 * title back the next morning has learned that their edits are worthless.
 *
 * Unknown lock names are ignored rather than throwing: `user_locked_fields` is
 * plain `text[]` and a stale name from an older schema must not break a sync.
 */
// `T extends object`, not `T extends Record<string, unknown>`: an interface has
// no implicit index signature, so `SyncedItemPayload` — the only thing this is
// ever called with — fails the stricter constraint.
export function applyLocks<T extends object>(
  payload: T,
  lockedFields: readonly string[],
): Partial<T> {
  if (lockedFields.length === 0) return payload;

  const locked = new Set(lockedFields);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!locked.has(key)) result[key] = value;
  }
  return result as Partial<T>;
}

/** Adds a field to a lock list, keeping it unique and sorted (stable diffs). */
export function withLockedField(lockedFields: readonly string[], field: string): string[] {
  return [...new Set([...lockedFields, field])].sort();
}

/**
 * Stops a failed course match from **unassigning** an item that already has a
 * course (§5.1).
 *
 * `matchCourse` returns `null` for "the chain did not answer", and
 * `toSyncedItemPayload` copies that straight into `course_id`. On an existing
 * row that is a destructive difference: the diff sees `courseId → null` and
 * writes it, silently tipping the item into the Unassigned bucket.
 *
 * ⚠ **Verified 2026-07-19 to be reachable.** Archiving a course is the trigger.
 * The archived course drops out of the match context, so every one of its
 * already-linked items stops matching, and the next sync empties `course_id` on
 * all of them — archiving `ATTENTION MANAGEMENT FOR LEARNING` would have dumped
 * its 2 items into a bucket that is meant to hold things needing a decision.
 * The same hole fires on a course rename and on a deleted `course_matchers` row.
 *
 * The rule this encodes: **matching is additive.** It may give an unassigned
 * item a course; it may move an item between courses when it positively
 * identifies a different one; it may never take a course away on the strength of
 * having no opinion. Losing a link is a decision, and no decision was made here.
 *
 * Locks are the user's veto and are applied separately — this guard covers the
 * unlocked rows, which is where the damage was.
 */
export function preserveCourseLink<T extends { course_id?: string | null }>(
  payload: T,
  existing: { course_id: string | null },
): T {
  if (payload.course_id !== null || existing.course_id === null) return payload;

  const { course_id: _dropped, ...rest } = payload;
  return rest as T;
}

/* -------------------------------------------------------------------------- */
/* Row-level diff (§3.2 layer 3)                                              */
/* -------------------------------------------------------------------------- */

/**
 * The occurrence columns a sync owns.
 *
 * `completed_at` is conspicuously absent, and that absence is the point: it is
 * the user's record that they did the thing, and no upstream edit may clear it.
 */
export interface OccurrencePayload {
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
  status: NormalizedOccurrence["status"];
  overridden: boolean;
}

/**
 * A stable string identity for an occurrence payload.
 *
 * Used to skip writes that would change nothing (§3.2 layer 3), so `updated_at`
 * keeps meaning "this row actually changed" rather than "a sync ran". Field
 * order is fixed by the literal below, not by `Object.keys`, so two equal
 * payloads always produce the same string.
 */
export function occurrenceFingerprint(payload: OccurrencePayload): string {
  return [
    instant(payload.starts_at),
    // A sentinel, not `""`. Mapping null onto the empty string would make
    // "no end time" and "an end time of empty string" the same fingerprint —
    // unreachable through the current schema, but the whole job of this
    // function is to be a faithful identity, and a lossy encoding in a
    // change-detector is how a real change silently stops being written.
    payload.ends_at === null ? "∅" : instant(payload.ends_at),
    payload.all_day ? "1" : "0",
    payload.status,
    payload.overridden ? "1" : "0",
  ].join("|");
}

/**
 * A timestamp reduced to the instant it denotes.
 *
 * **This is not defensive tidying — without it the row diff does not work at
 * all.** The parser produces `2026-06-12T08:00:00.000Z`; PostgREST returns the
 * same `timestamptz` as `2026-06-12T08:00:00+00:00`. Those are different
 * strings and the same moment, so a naive string fingerprint reported every
 * single row as changed on every sync. Verified against the real feed: 374
 * occurrences, 374 pointless rewrites on an otherwise no-op second run.
 *
 * Comparing epoch milliseconds makes the fingerprint mean what it is supposed
 * to mean — "is this the same instant?" — rather than "did two systems agree on
 * how to spell it?". An unparseable value falls back to the raw string, since
 * treating garbage as `NaN` would make all garbage equal.
 */
function instant(value: string): string {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : String(ms);
}

/**
 * The subset of `payload` that actually differs from what is stored.
 *
 * The item-level counterpart of `occurrenceFingerprint`, and it exists for the
 * same reason: a patch containing only unchanged values still fires the
 * `updated_at` trigger, still writes a WAL record, and still costs a network
 * round trip per row. On the real feed that was 374 needless UPDATEs per sync.
 *
 * Timestamps are compared as instants, everything else by value.
 */
export function changedFields<T extends object>(
  payload: T,
  current: Record<string, unknown>,
): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    const stored = current[key];
    if (stored === value) continue;
    // Postgres hands back `numeric` as a string and dates in its own spelling;
    // neither difference is a change.
    if (
      typeof value === "string" &&
      typeof stored === "string" &&
      instant(value) === instant(stored) &&
      Number.isNaN(Date.parse(value)) === false
    ) {
      continue;
    }
    result[key] = value;
  }
  return result as Partial<T>;
}

/** Normalizes a parsed occurrence into the row shape we persist. */
export function toOccurrencePayload(occurrence: NormalizedOccurrence): OccurrencePayload {
  return {
    starts_at: occurrence.startsAtUtc,
    ends_at: occurrence.endsAtUtc ?? null,
    all_day: occurrence.allDay,
    status: occurrence.status,
    overridden: occurrence.overridden,
  };
}

/* -------------------------------------------------------------------------- */
/* Tombstones (§3.3) and cancellations (§3.6)                                 */
/* -------------------------------------------------------------------------- */

/** The subset of a persisted `calendar_items` row the tombstone planner reads. */
export interface TombstoneCandidate {
  id: string;
  ics_uid: string;
  /** Null = manual quick-add. Sync must never touch these. */
  feed_id: string | null;
  missing_since: string | null;
  /**
   * The start of this item's **last** occurrence, or null when it has none.
   *
   * Load-bearing, and the reason this interface has a fourth field at all: without
   * a date the planner cannot tell a cancellation from a feed-window roll-off, and
   * it was deleting both. See `planTombstones`.
   *
   * **Last, not first.** An item with several occurrences is only safely "past"
   * when the final one is past — a weekly lecture whose first session was in
   * January is still live in May, and dating it by its earliest occurrence would
   * put the entire term's worth of a recurring class on the delete timer.
   */
  latestOccurrenceStartsAt: string | null;
}

export type TombstoneAction =
  /** Present in the snapshot and previously tombstoned — the item came back. */
  | { action: "clear"; id: string }
  /** Absent for the first time; start the grace period. */
  | { action: "mark"; id: string; missingSince: string }
  /** Absent, still inside the 7-day grace period. Left exactly as it is. */
  | { action: "keep"; id: string; missingSince: string }
  /** Absent for more than 7 continuous days. Now it really is gone. */
  | { action: "delete"; id: string }
  /**
   * Absent, and **not a cancellation** — kept forever, no clock started.
   *
   * Deliberately NOT folded into `keep`. `keep` means "the deletion clock is
   * running and has not expired"; `retain` means "there is no clock and never will
   * be". They differ in the only way that matters — whether this row can ever be
   * deleted — and a reader who cannot see that difference cannot review it.
   *
   * `clearMissingSince` is true when the row was tombstoned under the old rule and
   * that mark is now known to have been wrong. Leaving it set would keep the item
   * hidden at 24 h (`isTombstoneVisible`), so a row that is safe from deletion
   * would still have silently vanished from the UI.
   */
  | { action: "retain"; id: string; clearMissingSince: boolean };

/**
 * Whether a vanished item is one the feed simply stopped covering.
 *
 * ## 🔴 The data loss this closes — found 2026-07-19
 *
 * The IE feed emits zero `STATUS:CANCELLED`, so a cancelled lecture just vanishes.
 * `planTombstones` was built on that fact and drew the obvious conclusion: absent
 * means cancelled, start the 7-day clock, then delete. But an ICS feed is a
 * **rolling window**, and an event also vanishes when the window's trailing edge
 * slides past it. Those two look identical from inside the diff, and both were
 * being deleted.
 *
 * On the live database this was not hypothetical. All 5 tombstoned items started
 * `2026-01-19`; the feed's `earliest_live` had moved to `2026-01-21`. Nothing was
 * cancelled — the window rolled forward and the oldest day fell off the end. First
 * hard delete was due 2026-07-26. 220 of 374 occurrences are already in the past
 * and were on the same timer, and M1 item 9 hangs `attendance_records` and
 * `participation_logs` off `calendar_occurrences` — so from September this would
 * have been quietly destroying **graded** participation history as sessions aged
 * out of the window.
 *
 * The rule that separates them: **cancellation is only meaningful for something
 * that has not happened yet.** "The professor cancelled Thursday" is a statement
 * about a future Thursday. A session that already took place cannot be cancelled;
 * it can only be forgotten by the feed, and the feed forgetting it is not
 * permission to forget it too. So a vanished item whose last occurrence is in the
 * past is retained — permanently, with no clock.
 *
 * ## Why null is retained rather than deleted
 *
 * An item with no occurrence rows is a degenerate row, not a dated one: it carries
 * no evidence either way. The whole point of this function is that **deletion
 * requires positive evidence of future-ness**, and "we do not know when this was"
 * is the absence of evidence, not evidence of absence. Deleting on null would also
 * make the destructive path the one that fires when the data is most broken, which
 * is exactly backwards. It is retained, and if that ever accumulates junk, the
 * cleanup is a deliberate operation and not a side effect of a sync.
 */
function isFeedWindowRolloff(item: TombstoneCandidate, nowMs: number): boolean {
  if (item.latestOccurrenceStartsAt === null) return true;
  const startsAtMs = Date.parse(item.latestOccurrenceStartsAt);
  if (Number.isNaN(startsAtMs)) return true;
  return startsAtMs < nowMs;
}

/**
 * Decides what happens to every stored item of one feed, given the set of UIDs
 * the feed just returned.
 *
 * The four rules, in the order they matter:
 *
 *  1. **Reappearance clears the tombstone.** A UID that comes back is the same
 *     item it always was — same row, same id, so its `course_id`, its
 *     `completed_at` and every occurrence hanging off it survive untouched.
 *     Nothing is re-created, because nothing was destroyed.
 *  2. **A vanished PAST item is never deleted, and never even marked.** It is a
 *     feed-window roll-off, not a cancellation. See `isFeedWindowRolloff` for the
 *     full argument and the data loss it closes.
 *  3. **Absence of a FUTURE item starts a clock, it does not delete.**
 *     `missing_since` is only set when it was null, so a row absent for three days
 *     keeps its ORIGINAL timestamp instead of having the clock reset by every sync
 *     — otherwise the 7-day deadline would never arrive and nothing would ever be
 *     cleaned up.
 *  4. **Only continuous absence deletes.** Any reappearance in between resets the
 *     clock via rule 1, which is exactly the intent.
 *
 * Rule 2 is checked BEFORE rule 3, and the order is the fix. Under the old
 * ordering a past item was marked on the first sync that missed it and deleted
 * seven days later, and nothing downstream could tell that from a real
 * cancellation.
 *
 * Manual items (`feed_id === null`) are filtered out before any of this. They
 * are not in any feed's snapshot, so without this guard every single one would
 * be tombstoned on the first sync and deleted a week later.
 */
export function planTombstones(
  storedItems: readonly TombstoneCandidate[],
  presentUids: ReadonlySet<string>,
  nowIso: string,
  options: { deleteAfterMs?: number } = {},
): TombstoneAction[] {
  const deleteAfterMs = options.deleteAfterMs ?? TOMBSTONE_DELETE_AFTER_MS;
  const nowMs = Date.parse(nowIso);
  const actions: TombstoneAction[] = [];

  for (const item of storedItems) {
    // Manual items are never touched by sync (§3.3). Not "usually" — never.
    if (item.feed_id === null) continue;

    if (presentUids.has(item.ics_uid)) {
      if (item.missing_since !== null) actions.push({ action: "clear", id: item.id });
      continue;
    }

    // Rule 2, and it comes before the clock deliberately. A past item never
    // enters the tombstone lifecycle at all — not marked, not counted down, not
    // deleted. The `clearMissingSince` flag undoes a mark made under the old
    // rule, which is what lets an existing tombstone heal on the next sync
    // instead of needing a migration.
    if (isFeedWindowRolloff(item, nowMs)) {
      actions.push({
        action: "retain",
        id: item.id,
        clearMissingSince: item.missing_since !== null,
      });
      continue;
    }

    if (item.missing_since === null) {
      actions.push({ action: "mark", id: item.id, missingSince: nowIso });
      continue;
    }

    const absentForMs = nowMs - Date.parse(item.missing_since);
    if (absentForMs >= deleteAfterMs) {
      actions.push({ action: "delete", id: item.id });
    } else {
      actions.push({ action: "keep", id: item.id, missingSince: item.missing_since });
    }
  }

  return actions;
}

/**
 * Whether a tombstoned item should still be shown (§3.3: hidden at 24 h).
 *
 * Read-time, not write-time. The row keeps existing for a week either way; this
 * only decides whether a view renders it, so the grace period can be tuned
 * without a migration and without losing data already tombstoned.
 */
export function isTombstoneVisible(
  missingSince: string | null,
  nowIso: string,
  hideAfterMs: number = TOMBSTONE_HIDE_AFTER_MS,
): boolean {
  if (missingSince === null) return true;
  return Date.parse(nowIso) - Date.parse(missingSince) < hideAfterMs;
}

/**
 * Whether a cancelled occurrence should still be rendered struck through
 * (§3.6: kept visible for 7 days, then hidden).
 *
 * A cancelled lecture is *information* — "this is not happening" is something
 * the user needs to see, and a silent gap in the week is not the same message.
 * After a week it stops being news.
 *
 * `cancelledAt` is the occurrence's `updated_at`, which the row-level diff (see
 * `occurrenceFingerprint`) only advances when the payload genuinely changed —
 * so for a cancelled row it is the moment the status flipped. There is no
 * dedicated `cancelled_at` column, and this is why one is not needed.
 */
export function isCancelledOccurrenceVisible(
  cancelledAt: string,
  nowIso: string,
  visibleMs: number = CANCELLED_VISIBLE_MS,
): boolean {
  return Date.parse(nowIso) - Date.parse(cancelledAt) < visibleMs;
}

/**
 * Occurrence rows of a still-present item whose instance is gone from the
 * snapshot — §3.6 form 2 (an `EXDATE` added upstream, or `METHOD:CANCEL`).
 *
 * These are marked cancelled rather than deleted, for the same reason as form 1:
 * a lecture that was on the calendar and now is not is something the user is
 * entitled to see. Rows already cancelled are skipped so the diff stays a no-op
 * and `updated_at` — which is what dates the strike-through — is not reset on
 * every sync.
 */
export function planOrphanedOccurrences(
  storedOccurrences: readonly { id: string; recurrence_id: string; status: string }[],
  snapshotOccurrences: readonly NormalizedOccurrence[],
): string[] {
  const present = new Set(snapshotOccurrences.map((occurrence) => occurrence.recurrenceId));
  return storedOccurrences
    .filter(
      (occurrence) => !present.has(occurrence.recurrence_id) && occurrence.status !== "cancelled",
    )
    .map((occurrence) => occurrence.id);
}

/* -------------------------------------------------------------------------- */
/* Event → row                                                                */
/* -------------------------------------------------------------------------- */

/** The feed-derived half of a `calendar_items` row. */
export interface SyncedItemPayload {
  title: string;
  kind: NormalizedEvent["kind"];
  raw_summary: string;
  description: string | null;
  location: string | null;
  rrule: string | null;
  original_tzid: string | null;
  sequence: number;
  session_from: number | null;
  session_to: number | null;
  descriptor: NonNullable<NormalizedEvent["descriptor"]> | null;
  course_id: string | null;
}

/**
 * Turns a parsed event plus a resolved course into the columns sync owns.
 *
 * `courseId` is passed in rather than derived here because course matching is a
 * per-user lookup against `courses` and `course_matchers` — I/O, and therefore
 * the engine's job, not this module's.
 */
export function toSyncedItemPayload(
  event: NormalizedEvent,
  courseId: string | null,
): SyncedItemPayload {
  return {
    title: event.title,
    kind: event.kind,
    raw_summary: event.rawSummary,
    description: event.description ?? null,
    location: event.location ?? null,
    rrule: event.rrule ?? null,
    original_tzid: event.originalTzid ?? null,
    sequence: event.sequence,
    session_from: event.sessionFrom ?? null,
    session_to: event.sessionTo ?? null,
    descriptor: event.descriptor ?? null,
    course_id: courseId,
  };
}
