-- Re-heal the feed-window roll-off tombstones (review gate 6).
--
-- `20260719092715_clear_feed_window_rolloff_tombstones.sql` cleared exactly five
-- rows. They are marked again. Verified 2026-07-19 against this project: the
-- same five items (all on feed d085e882, one occurrence each, 2026-01-19 at
-- 08:30 / 10:00 / 14:00 / 17:00 / 23:00 UTC) now carry
-- `missing_since = 2026-07-19 11:41:23.616+00`.
--
-- ## What re-marked them, and why the code fix is not at fault
--
-- 11:41 is AFTER `a0fef63` (11:28) landed the `planTombstones` fix, so the
-- marking was not done by this branch's logic — a sync executed by a build
-- started before that commit did it. Traced against the code as it stood at
-- 11:41, the roll-off branch already returned `retain` with
-- `clearMissingSince: true` for a past-dated item, which clears rather than
-- marks. The marks are residue from an older build, not a live regression.
--
-- ## Why it still could not be left to the next sync
--
-- The mark is harmless to the ROW — rule 2 of `planTombstones` routes a
-- past-dated item to `retain`, so the `delete` branch is unreachable for these
-- five and the 7-day hard delete never fires. It is not harmless to the VIEW.
-- `isTombstoneVisible` hides a tombstoned item 24 hours after its mark, so from
-- 2026-07-20 11:41 these five classes silently vanish from the January calendar
-- until some sync happens to run and heal them. Waiting on a sync makes a
-- user-visible disappearance a race against deployment timing, which is the same
-- objection the first migration raised.
--
-- The predicate is the original's, unchanged and deliberately so: it is
-- idempotent, it is a no-op on a fresh database, and it heals anything marked
-- between now and this being applied rather than pinning five uuids. Future-dated
-- tombstones are still left alone — a future event vanishing IS a cancellation,
-- and clearing those would replace one bug with its mirror image.
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
