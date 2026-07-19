-- Heartbeat rows written by the Inngest health-check function (M1 item 2, §3).
--
-- ## Why this table exists
--
-- It is the observable end of the background-job round trip. `/api/inngest` is
-- a gate-exempt endpoint whose whole justification is that Inngest can reach it
-- and run our code; a function that only logged would prove none of that
-- survived the hop. A row that appears here proves four things at once: the
-- event reached Inngest, Inngest called back into our deployment, the function
-- body executed, and `createAdminSupabaseClient` can actually write.
--
-- ## Why it is user-owned
--
-- Jobs run under `createAdminSupabaseClient`, which bypasses RLS. That is
-- correct for background work — there is no request user to derive a session
-- from — but it makes the `user_id` column a discipline rather than something
-- the database enforces for us on the write path. Every row a job writes still
-- carries the user it was done on behalf of, and this table holds itself to
-- that rule so the first job in the codebase sets the pattern the document
-- pipeline (item 5) will follow rather than a looser one.
--
-- ## Policies
--
-- SELECT only. Nothing user-facing writes here: heartbeats are authored by the
-- system, and the admin client bypasses RLS anyway, so an INSERT/UPDATE/DELETE
-- policy would grant reach to browsers without enabling anything the job needs.
-- Read access is granted so a row stays inspectable from the app as its owner
-- rather than only through the secret key.

create table public.job_heartbeats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The Inngest function id that wrote the row, e.g. 'health-check'.
  job text not null,
  -- Inngest's run id, so a row can be traced back to a specific execution in
  -- the dashboard. Text, not uuid: Inngest run ids are ULIDs.
  run_id text not null,
  created_at timestamptz not null default now()
);

comment on table public.job_heartbeats is
  'Round-trip proof written by the Inngest health-check function. Rows are transient: the function deletes its own row before returning, so an empty table is the expected steady state.';

alter table public.job_heartbeats enable row level security;

create policy "Users can view own job heartbeats"
  on public.job_heartbeats
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- The health check reads back the row it just wrote by (user_id, job). Without
-- this the lookup is a sequential scan; with it the table can also answer
-- "when did this job last run for this user" cheaply if that is ever wanted.
create index job_heartbeats_user_job_created_idx
  on public.job_heartbeats (user_id, job, created_at desc);
