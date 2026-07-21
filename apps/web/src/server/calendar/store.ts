/**
 * The persistence port the sync engine runs against.
 *
 * The engine talks to this interface and never to Supabase directly. That is
 * not architecture for its own sake — it is what makes the tombstone lifecycle
 * testable. §3.3's rules ("a UID that reappears keeps its identity", "manual
 * items are never touched", "only *continuous* absence deletes") are statements
 * about a sequence of syncs over time, and proving them against a live database
 * would mean either a seven-day test or a pile of hand-forged timestamps in a
 * shared project. Against an in-memory implementation of this interface they
 * are ordinary unit tests.
 *
 * The Supabase implementation lives in `store-supabase.ts` and is deliberately
 * thin: every decision worth testing has already been made by the time it is
 * called.
 */

import type { Json } from "@study/db";

/** A `calendar_feeds` row, as the engine needs it. */
export interface FeedRow {
  id: string;
  user_id: string;
  provider: string;
  label: string;
  config: Json;
  sync_cursor: Json;
}

/**
 * The `calendar_items` columns the engine reads back when diffing.
 *
 * Carries every column a sync can write, not just the identity ones, because
 * the engine compares before it patches. Reading eleven extra columns in one
 * query is free; writing 374 rows that did not change is not.
 */
export interface StoredItem {
  id: string;
  user_id: string;
  feed_id: string | null;
  ics_uid: string;
  course_id: string | null;
  user_locked_fields: string[];
  missing_since: string | null;
  title: string;
  kind: string;
  raw_summary: string | null;
  description: string | null;
  location: string | null;
  rrule: string | null;
  original_tzid: string | null;
  sequence: number;
  session_from: number | null;
  session_to: number | null;
  descriptor: string | null;
  hidden: boolean;
  is_exam_candidate: boolean;
  detection_source: string | null;
}

/** The `calendar_occurrences` columns the engine reads back when diffing. */
export interface StoredOccurrence {
  id: string;
  item_id: string;
  recurrence_id: string;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
  status: string;
  overridden: boolean;
}

/** What one sync run knows about the owning user. */
export interface SyncContext {
  /** `profiles.timezone` — how floating times are interpreted (§3.4 rule 4). */
  timezone: string;
  courses: { id: string; code: string | null; title: string; total_sessions: number | null }[];
  matchers: { course_id: string; pattern: string }[];
  assessments: {
    id: string;
    course_id: string;
    title: string;
    kind: string;
    session_number: number | null;
    /** §2b: only a confirmed row may move an exam date. See `AssessmentOracleRow`. */
    confirmed: boolean;
  }[];
  semesters: { starts_on: string; ends_on: string }[];
}

/** How a run ends. Written back onto the feed row. */
export interface FeedCompletion {
  status: "ok" | "unchanged" | "error";
  /** ALREADY REDACTED by the caller. Never contains a feed URL. */
  error: string | null;
  cursor: Json;
  syncedAt: string;
}

export interface ItemUpsert {
  user_id: string;
  feed_id: string;
  ics_uid: string;
  source: "ics";
  title: string;
  kind: string;
  raw_summary: string | null;
  description: string | null;
  location: string | null;
  rrule: string | null;
  original_tzid: string | null;
  sequence: number;
  session_from: number | null;
  session_to: number | null;
  descriptor: string | null;
  course_id: string | null;
}

export interface OccurrenceUpsert {
  user_id: string;
  item_id: string;
  recurrence_id: string;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
  status: string;
  overridden: boolean;
}

export interface CalendarStore {
  /**
   * Takes the per-feed lock (§3.1) and returns the feed, or null if another run
   * already holds it — in which case this run ends silently, which is the
   * specified behaviour.
   */
  claimFeed(feedId: string, leaseSeconds: number): Promise<FeedRow | null>;

  /** Records the outcome and releases the lease. Always called, including on failure. */
  finishFeed(feedId: string, completion: FeedCompletion): Promise<void>;

  loadContext(userId: string): Promise<SyncContext>;

  /**
   * EVERY item the user owns, across all feeds and including manual ones.
   *
   * Deliberately not scoped to the feed being synced. The engine does that
   * filtering itself, in code, so that "manual items are never touched by sync"
   * is a property of the engine that a test can falsify — rather than an
   * invisible side effect of a `where feed_id = …` in a query, which would make
   * the test pass without the rule existing.
   */
  listUserItems(userId: string): Promise<StoredItem[]>;

  listOccurrences(itemIds: readonly string[]): Promise<StoredOccurrence[]>;

  /**
   * Which of these occurrences carry GRADED HISTORY — an `attendance_records`
   * or `participation_logs` row (§6.3). Returns the subset of ids that do.
   *
   * The tombstone sweep runs this alongside `listOccurrences` so it can decide
   * before it deletes: an item with any graded occurrence is retained, never
   * swept, because those two ledger FKs are `ON DELETE NO ACTION` and a delete
   * that reached them would abort with 23503 and wedge the feed forever (the
   * §6.3 defect). `talking_points` are deliberately NOT counted — they cascade
   * by design, so a throwaway prep note must not be able to pin a class in place.
   *
   * Occurrence-level rather than item-level because the sweep already holds the
   * occurrence rows from `listOccurrences`, and the two ledger tables are keyed
   * on `occurrence_id`; the caller folds the answer up to items itself.
   */
  listLedgerBearingOccurrences(occurrenceIds: readonly string[]): Promise<ReadonlySet<string>>;

  /**
   * Upserts on the `(feed_id, ics_uid)` identity, returning each row's id keyed
   * by its UID.
   *
   * Batched rather than one-at-a-time because the real feed is 374 events and
   * each round trip to Supabase costs a few hundred milliseconds — sequentially
   * that was three minutes of wall clock, comfortably past a serverless
   * function's ceiling.
   */
  upsertItems(rows: readonly ItemUpsert[]): Promise<Map<string, string>>;

  /**
   * Writes a named subset of columns. `object` rather than a column union
   * because the engine passes a lock-filtered payload whose exact key set is
   * only known at runtime — which is the entire mechanism by which a locked
   * column stays out of the statement.
   */
  patchItem(id: string, patch: object): Promise<void>;

  deleteItems(ids: readonly string[]): Promise<void>;

  /** Upserts on the `(item_id, recurrence_id)` identity. */
  upsertOccurrences(rows: readonly OccurrenceUpsert[]): Promise<void>;

  /** §3.6: mark orphaned instances cancelled rather than deleting them. */
  cancelOccurrences(ids: readonly string[]): Promise<void>;
}
