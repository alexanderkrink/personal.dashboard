-- Exact FK-covering indexes for calendar_items.feed_id and
-- calendar_occurrences.item_id.
--
-- 20260718174222 argued that these two foreign keys needed no index of their own,
-- because a unique constraint already led with the FK's first column:
--   calendar_items.feed_id       -> calendar_items_feed_uid_key (feed_id, ics_uid)
--   calendar_occurrences.item_id -> calendar_occurrences_item_recurrence_key (item_id, …)
--
-- That argument is WRONG, and the query planner says so. Both FKs are composite
-- (fk_column, user_id), so the referential-action query is
-- `where item_id = $1 and user_id = $2`. Against that predicate the planner does
-- not use the (item_id, recurrence_id) index at all — it picks the
-- broader-looking user_id index and applies item_id as a filter:
--
--   Bitmap Heap Scan on calendar_occurrences
--     Recheck Cond: (user_id = $2)
--     Filter: (item_id = $1)
--     ->  Bitmap Index Scan on calendar_occurrences_user_starts_idx
--
-- i.e. deleting ONE item walks every occurrence the user owns. With a −30d/+180d
-- horizon over seven courses that is thousands of rows scanned to remove a
-- handful, and it grows every semester. Supabase's `unindexed_foreign_keys`
-- linter flagged both, correctly.
--
-- A separate migration rather than an edit, because 20260718174222 is already
-- applied and applied migrations are never edited.

create index calendar_items_feed_id_idx
  on public.calendar_items (feed_id, user_id);

create index calendar_occurrences_item_id_idx
  on public.calendar_occurrences (item_id, user_id);
