-- Un-mark the tombstones that were feed-window roll-offs, not cancellations.
--
-- Companion to the `planTombstones` fix in apps/web/src/server/calendar/diff.ts.
-- That change stops NEW past-dated items from ever entering the tombstone
-- lifecycle, and heals existing ones on the next sync. This migration does the
-- healing deterministically instead of hoping a sync runs in time.
--
-- WHY IT COULD NOT WAIT: all 5 tombstoned rows carried
-- `missing_since = 2026-07-19 00:00:40.41+00`, so the 7-day hard delete was due
-- **2026-07-26**. Waiting for a sync would have made the deadline a race against
-- deployment timing, on a path whose entire failure mode is silent data loss.
--
-- WHAT THE 5 ROWS ACTUALLY WERE (verified against this project, 2026-07-19):
-- every one has exactly one occurrence, all on 2026-01-19 (08:30, 10:00, 14:00,
-- 17:00, 23:00 UTC), all on feed d085e882. The feed's `earliest_live` had moved to
-- 2026-01-21. Nothing was cancelled — the rolling window slid forward two days and
-- the oldest day dropped off the end. Counted immediately before this ran:
--   tombstoned_total = 5, tombstoned_past = 5, tombstoned_future = 0.
--
-- The predicate, not the ids, is what does the work. Hard-coding the 5 uuids would
-- be a fix for one afternoon; expressing the RULE means it also catches anything
-- marked between now and this being applied, and it is a no-op on a fresh database
-- where none of these rows exist.
--
-- Deliberately NOT touching future-dated tombstones. A future event vanishing IS a
-- cancellation, the 7-day lifecycle is correct for it, and clearing those would
-- replace one bug with its mirror image. On this project there were zero of them,
-- but the predicate says so explicitly rather than relying on that.
update public.calendar_items i
set missing_since = null
where i.missing_since is not null
  and coalesce(
    (select max(o.starts_at) from public.calendar_occurrences o where o.item_id = i.id),
    -- No occurrences at all: no evidence of future-ness, so it is not deletable
    -- and must not be sitting on a deletion clock. `-infinity` makes it compare as
    -- past, matching `isFeedWindowRolloff`'s null branch.
    '-infinity'::timestamptz
  ) < now();
