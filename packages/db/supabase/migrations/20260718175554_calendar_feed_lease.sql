-- The per-feed concurrency guard (§3.1), as a lease plus a claim function.
--
-- §3.1 specifies `select … for update skip locked`: a second overlapping sync
-- run skips silently. That primitive holds a ROW LOCK FOR THE DURATION OF A
-- TRANSACTION, which is the right answer when the job owns a database
-- connection for its whole life.
--
-- This sync does not. It runs over supabase-js (PostgREST), where every
-- statement is its own transaction, and it spends most of its wall-clock time
-- inside an HTTP fetch of the ICS feed — outside the database entirely. A
-- `for update skip locked` issued from that client would release the instant
-- the statement returned, guarding nothing at all: the second run would take the
-- lock a millisecond later and both would proceed. It would look exactly like
-- the spec and provide none of its behaviour.
--
-- So the guard is a LEASE, and `for update skip locked` is used for the part it
-- genuinely fits — serialising two claims that arrive at the same instant:
--
--   1. `for update skip locked` on the feed row. Two simultaneous claims: one
--      gets the row, the other gets nothing and returns immediately rather than
--      blocking behind it. This is the spec's mechanism, doing the spec's job.
--   2. A lease timestamp that outlives the transaction, so the claim still holds
--      while the run is off fetching a URL for twenty seconds.
--   3. An expiry, so a run that crashes without releasing does not lock the feed
--      out forever. A stale lease is reclaimable; that is the difference between
--      a lease and a lock.
--
-- ⚠ Recorded in PLAN §3.1 as a dated divergence.

alter table public.calendar_feeds
  add column sync_lease_expires_at timestamptz;

comment on column public.calendar_feeds.sync_lease_expires_at is
  'Concurrency guard (§3.1). Non-null and in the future means a sync run holds this feed. Released by the run, or reclaimed once expired if the run died.';

-- Claims a feed for one sync run, or returns nothing if it is already claimed.
--
-- SECURITY INVOKER (the default) is deliberate and sufficient: the only caller
-- is the background sync, which runs under the service role and already
-- bypasses RLS. A security definer here would grant every authenticated user
-- the power to seize another user's feed lease, which is a denial-of-service
-- primitive handed out for no reason. Under RLS an ordinary user simply sees no
-- row for a feed they do not own, and the function returns nothing — correct.
create function public.claim_calendar_feed(
  p_feed_id uuid,
  p_lease_seconds int default 300
)
returns setof public.calendar_feeds
language plpgsql
set search_path = ''
as $$
declare
  v_locked public.calendar_feeds;
begin
  -- SKIP LOCKED, not NOWAIT and not a plain wait: an overlapping run must skip
  -- SILENTLY (§3.1), not queue up behind the first and then duplicate its work.
  select * into v_locked
  from public.calendar_feeds
  where id = p_feed_id
    and active
  for update skip locked;

  if not found then
    return;
  end if;

  -- A live lease means another run is mid-flight. Expired means its owner died,
  -- and reclaiming is the whole point of an expiry.
  if v_locked.sync_lease_expires_at is not null
     and v_locked.sync_lease_expires_at > now() then
    return;
  end if;

  return query
    update public.calendar_feeds
      set sync_lease_expires_at = now() + make_interval(secs => p_lease_seconds)
      where id = p_feed_id
      returning *;
end;
$$;

comment on function public.claim_calendar_feed(uuid, int) is
  'Takes the §3.1 per-feed sync lease. Returns the feed row, or no rows if another run holds it or the feed is inactive.';
