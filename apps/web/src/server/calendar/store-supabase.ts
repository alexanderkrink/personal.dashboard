/**
 * The Supabase implementation of `CalendarStore`.
 *
 * Deliberately thin, and deliberately dull: by the time anything here is
 * called, every decision worth arguing about has already been made and tested
 * in `diff.ts` and `sync.ts`. What is left is column mapping and upsert
 * conflict targets.
 *
 * **Runs under `createAdminSupabaseClient`, which bypasses RLS.** Every write
 * below carries an explicit `user_id` taken from the claimed feed row, and the
 * composite `(id, user_id)` foreign keys reject the row if it is ever wrong.
 */

import type { SupabaseAdminClient } from "@study/db";
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

/** Chunk size for `in (…)` filters, so a big feed can't blow the URL length. */
const IN_CHUNK = 200;

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export function createSupabaseCalendarStore(supabase: SupabaseAdminClient): CalendarStore {
  return {
    async claimFeed(feedId, leaseSeconds): Promise<FeedRow | null> {
      // The atomic claim lives in SQL (see 20260718175554): `for update skip
      // locked` plus a lease. It cannot be expressed as a PostgREST query,
      // because the lock has to be taken and the lease written in one
      // transaction.
      const { data, error } = await supabase.rpc("claim_calendar_feed", {
        p_feed_id: feedId,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throw new Error(`Could not claim feed: ${error.message}`);

      const row = data?.[0];
      if (!row) return null;

      return {
        id: row.id,
        user_id: row.user_id,
        provider: row.provider,
        label: row.label,
        config: row.config,
        sync_cursor: row.sync_cursor,
      };
    },

    async finishFeed(feedId, completion: FeedCompletion): Promise<void> {
      const { error } = await supabase
        .from("calendar_feeds")
        .update({
          last_sync_status: completion.status,
          // Already redacted by the engine. Nothing constructs this string from
          // a network error without passing it through `redactSecrets` first.
          last_sync_error: completion.error,
          last_synced_at: completion.syncedAt,
          sync_cursor: completion.cursor,
          // Releasing the lease is part of the same statement that records the
          // outcome, so there is no ordering in which a run reports success and
          // leaves the feed locked.
          sync_lease_expires_at: null,
        })
        .eq("id", feedId);
      if (error) throw new Error(`Could not finish feed: ${error.message}`);
    },

    async loadContext(userId): Promise<SyncContext> {
      const [profile, courses, matchers, assessments, semesters] = await Promise.all([
        supabase.from("profiles").select("timezone").eq("id", userId).maybeSingle(),
        // Archived courses are excluded from MATCHING, not from the data.
        //
        // Archiving means "I am done with this course" — it must stop claiming
        // newly synced events, or a course archived in June keeps absorbing
        // events forever. What it must NOT do is break the links it already
        // has, and it does not: `preserveCourseLink` stops a now-unmatchable
        // course being nulled out of its existing rows, so archiving moves a
        // course out of the way without dropping its history into Unassigned.
        supabase
          .from("courses")
          .select("id, code, title, total_sessions")
          .eq("user_id", userId)
          .eq("archived", false),
        supabase.from("course_matchers").select("course_id, pattern").eq("user_id", userId),
        supabase
          .from("assessments")
          .select("id, course_id, title, kind, session_number")
          .eq("user_id", userId),
        supabase.from("semesters").select("starts_on, ends_on").eq("user_id", userId),
      ]);

      return {
        // Falling back to the schema default rather than the server's zone:
        // a sync that silently interpreted floating times in whatever region
        // the function happened to run in is the §3.4 failure mode exactly.
        timezone: profile.data?.timezone ?? "Europe/Madrid",
        courses: courses.data ?? [],
        matchers: matchers.data ?? [],
        assessments: assessments.data ?? [],
        semesters: semesters.data ?? [],
      };
    },

    async listUserItems(userId): Promise<StoredItem[]> {
      // Every column a sync can write, so the engine can compare before it
      // patches. Eleven extra columns in one query is free; 374 no-op UPDATEs
      // per sync is not.
      const { data, error } = await supabase
        .from("calendar_items")
        .select(
          "id, user_id, feed_id, ics_uid, course_id, user_locked_fields, missing_since, title, kind, raw_summary, description, location, rrule, original_tzid, sequence, session_from, session_to, descriptor, hidden, is_exam_candidate, detection_source",
        )
        .eq("user_id", userId);
      if (error) throw new Error(`Could not load calendar items: ${error.message}`);
      return data ?? [];
    },

    async listOccurrences(itemIds): Promise<StoredOccurrence[]> {
      if (itemIds.length === 0) return [];
      const results: StoredOccurrence[] = [];
      for (const batch of chunk(itemIds, IN_CHUNK)) {
        const { data, error } = await supabase
          .from("calendar_occurrences")
          .select("id, item_id, recurrence_id, starts_at, ends_at, all_day, status, overridden")
          .in("item_id", batch);
        if (error) throw new Error(`Could not load occurrences: ${error.message}`);
        results.push(...(data ?? []));
      }
      return results;
    },

    async upsertItems(rows: readonly ItemUpsert[]): Promise<Map<string, string>> {
      const ids = new Map<string, string>();
      for (const batch of chunk(rows, IN_CHUNK)) {
        const { data, error } = await supabase
          .from("calendar_items")
          .upsert(batch as never, { onConflict: "feed_id,ics_uid" })
          .select("id, ics_uid");
        if (error) throw new Error(`Could not upsert calendar items: ${error.message}`);
        for (const row of data ?? []) ids.set(row.ics_uid, row.id);
      }
      return ids;
    },

    async patchItem(id, patch): Promise<void> {
      const { error } = await supabase
        .from("calendar_items")
        .update(patch as never)
        .eq("id", id);
      if (error) throw new Error(`Could not update calendar item: ${error.message}`);
    },

    async deleteItems(ids): Promise<void> {
      if (ids.length === 0) return;
      for (const batch of chunk(ids, IN_CHUNK)) {
        const { error } = await supabase.from("calendar_items").delete().in("id", batch);
        if (error) throw new Error(`Could not delete calendar items: ${error.message}`);
      }
    },

    async upsertOccurrences(rows: readonly OccurrenceUpsert[]): Promise<void> {
      if (rows.length === 0) return;
      for (const batch of chunk(rows, IN_CHUNK)) {
        const { error } = await supabase
          .from("calendar_occurrences")
          .upsert(batch as never, { onConflict: "item_id,recurrence_id" });
        if (error) throw new Error(`Could not upsert occurrences: ${error.message}`);
      }
    },

    async cancelOccurrences(ids): Promise<void> {
      if (ids.length === 0) return;
      for (const batch of chunk(ids, IN_CHUNK)) {
        const { error } = await supabase
          .from("calendar_occurrences")
          .update({ status: "cancelled" })
          .in("id", batch);
        if (error) throw new Error(`Could not cancel occurrences: ${error.message}`);
      }
    },
  };
}
