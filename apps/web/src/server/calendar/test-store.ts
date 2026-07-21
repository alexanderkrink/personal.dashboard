/**
 * An in-memory `CalendarStore` for the engine tests.
 *
 * Exists so §3.3's lifecycle can be tested as what it actually is — a sequence
 * of syncs across days — instead of as a snapshot. The tombstone flow is the
 * only mechanism that can detect a cancelled lecture in the IE feed (it emits
 * no `STATUS:CANCELLED` at all), and its rules are all about *time*: hidden at
 * 24 h, deleted after 7 days of CONTINUOUS absence, cleared on reappearance.
 * Proving those against the real database would mean forging timestamps in a
 * live project; proving them here is four calls to `syncFeed` with four `now`s.
 *
 * Test support, not production code — it is imported only from `*.test.ts`.
 */

import type { Json } from "@study/db";
import type {
  CalendarStore,
  FeedCompletion,
  FeedRow,
  ItemUpsert,
  OccurrenceUpsert,
  StoredItem,
  StoredOccurrence,
  SyncContext,
} from "./store";

export interface MemoryItem extends StoredItem {
  /** Not a synced column — the user's own override, so sync must never write it. */
  weight_override: number | null;
}

export interface MemoryOccurrence extends StoredOccurrence {
  user_id: string;
  /** The user's own record that they did the thing. Sync must never clear it. */
  completed_at: string | null;
  updated_at: string;
}

export interface MemoryStoreState {
  feed: FeedRow & { leaseExpiresAt: string | null };
  completions: FeedCompletion[];
  context: SyncContext;
  items: MemoryItem[];
  occurrences: MemoryOccurrence[];
  /**
   * Occurrence ids that carry GRADED HISTORY — an `attendance_records` or a
   * `participation_logs` row. This is the ledger the real schema hangs off
   * `calendar_occurrences` with `ON DELETE NO ACTION` (migration 20260720222423);
   * modelling it as a set of occurrence ids is all the sweep needs to see.
   *
   * Its two jobs mirror the two things the database does: `deleteItems` consults
   * it to refuse a delete that would orphan graded history (the NO ACTION FK,
   * SQLSTATE 23503), and `listLedgerBearingOccurrences` reports it so the sweep
   * can retain BEFORE it ever attempts that delete. Without the first, a
   * wholesale delete would silently succeed here and the §6.3 wedge could not be
   * reproduced in a test; without the second, the fix could not be proven.
   *
   * `talking_points` are pointedly absent — they cascade with the occurrence, so
   * they never wedge a delete and are not graded history.
   */
  ledgerOccurrenceIds: Set<string>;
  nextId: number;
}

export function createMemoryStore(overrides: Partial<MemoryStoreState> = {}): {
  store: CalendarStore;
  state: MemoryStoreState;
} {
  const state: MemoryStoreState = {
    feed: {
      id: "feed-1",
      user_id: "user-1",
      provider: "ics",
      label: "IE Agenda",
      config: { url: "https://calendar.example.edu/agenda/tokentokentoken.ics" } as Json,
      sync_cursor: null,
      leaseExpiresAt: null,
    },
    completions: [],
    context: {
      timezone: "Europe/Madrid",
      courses: [],
      matchers: [],
      assessments: [],
      semesters: [],
    },
    items: [],
    occurrences: [],
    ledgerOccurrenceIds: new Set(),
    nextId: 1,
    ...overrides,
  };

  const id = (prefix: string) => {
    const value = `${prefix}-${state.nextId}`;
    state.nextId += 1;
    return value;
  };

  const store: CalendarStore = {
    async claimFeed(feedId, leaseSeconds) {
      if (feedId !== state.feed.id) return null;
      const now = Date.now();
      // Mirrors claim_calendar_feed(): a live lease means another run holds it.
      if (state.feed.leaseExpiresAt && Date.parse(state.feed.leaseExpiresAt) > now) return null;
      state.feed.leaseExpiresAt = new Date(now + leaseSeconds * 1000).toISOString();
      return { ...state.feed };
    },

    async finishFeed(_feedId, completion) {
      state.completions.push(completion);
      state.feed.sync_cursor = completion.cursor;
      state.feed.leaseExpiresAt = null;
    },

    async loadContext() {
      return state.context;
    },

    async listUserItems(userId) {
      return state.items.filter((item) => item.user_id === userId).map((item) => ({ ...item }));
    },

    async listOccurrences(itemIds) {
      const wanted = new Set(itemIds);
      return state.occurrences
        .filter((occurrence) => wanted.has(occurrence.item_id))
        .map((occurrence) => ({ ...occurrence }));
    },

    async listLedgerBearingOccurrences(occurrenceIds) {
      const asked = new Set(occurrenceIds);
      const bearing = new Set<string>();
      for (const id of state.ledgerOccurrenceIds) {
        if (asked.has(id)) bearing.add(id);
      }
      return bearing;
    },

    async upsertItems(rows: readonly ItemUpsert[]) {
      const ids = new Map<string, string>();
      for (const row of rows) {
        const existing = state.items.find(
          (item) => item.feed_id === row.feed_id && item.ics_uid === row.ics_uid,
        );
        if (existing) {
          Object.assign(existing, row);
          ids.set(row.ics_uid, existing.id);
          continue;
        }
        const created: MemoryItem = {
          id: id("item"),
          user_id: row.user_id,
          feed_id: row.feed_id,
          ics_uid: row.ics_uid,
          course_id: row.course_id,
          user_locked_fields: [],
          missing_since: null,
          title: row.title,
          kind: row.kind,
          raw_summary: row.raw_summary,
          description: row.description,
          location: row.location,
          rrule: row.rrule,
          original_tzid: row.original_tzid,
          descriptor: row.descriptor,
          session_from: row.session_from,
          session_to: row.session_to,
          hidden: false,
          is_exam_candidate: false,
          detection_source: null,
          weight_override: null,
          sequence: row.sequence,
        };
        state.items.push(created);
        ids.set(row.ics_uid, created.id);
      }
      return ids;
    },

    async patchItem(itemId, patch) {
      const item = state.items.find((entry) => entry.id === itemId);
      if (item) Object.assign(item, patch);
    },

    async deleteItems(ids) {
      const doomed = new Set(ids);
      const doomedOccurrences = state.occurrences.filter((occurrence) =>
        doomed.has(occurrence.item_id),
      );

      // The NO ACTION backstop, modelled faithfully. A calendar_items delete
      // cascades to its calendar_occurrences (calendar_occurrences_item_id_fkey,
      // ON DELETE CASCADE) — but those occurrences may be POINTED AT by
      // attendance_records / participation_logs whose FK is ON DELETE NO ACTION,
      // checked at end of statement. If any doomed occurrence carries graded
      // history the whole statement aborts with 23503 and NOTHING is removed;
      // that rollback is the §6.3 wedge, and reproducing it is why this throws
      // BEFORE mutating any state.
      const blocking = doomedOccurrences.find((occurrence) =>
        state.ledgerOccurrenceIds.has(occurrence.id),
      );
      if (blocking) {
        throw new Error(
          `update or delete on table "calendar_occurrences" violates foreign key ` +
            `constraint "attendance_records_occurrence_id_fkey" on table ` +
            `"attendance_records" (SQLSTATE 23503)`,
        );
      }

      state.items = state.items.filter((item) => !doomed.has(item.id));
      // The real schema cascades via calendar_occurrences_item_id_fkey.
      state.occurrences = state.occurrences.filter((occurrence) => !doomed.has(occurrence.item_id));
    },

    async upsertOccurrences(rows: readonly OccurrenceUpsert[]) {
      for (const row of rows) {
        const existing = state.occurrences.find(
          (occurrence) =>
            occurrence.item_id === row.item_id && occurrence.recurrence_id === row.recurrence_id,
        );
        if (existing) {
          // completed_at is NOT in OccurrenceUpsert, so it survives — the same
          // reason it survives in Postgres.
          Object.assign(existing, row, { updated_at: new Date().toISOString() });
        } else {
          state.occurrences.push({
            id: id("occ"),
            completed_at: null,
            updated_at: new Date().toISOString(),
            ...row,
          });
        }
      }
    },

    async cancelOccurrences(ids) {
      const doomed = new Set(ids);
      for (const occurrence of state.occurrences) {
        if (doomed.has(occurrence.id)) {
          occurrence.status = "cancelled";
          occurrence.updated_at = new Date().toISOString();
        }
      }
    },
  };

  return { store, state };
}
