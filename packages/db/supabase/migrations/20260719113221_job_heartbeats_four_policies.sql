-- Bring job_heartbeats to the four-per-operation RLS convention.
--
-- It shipped with one policy (SELECT). That was fail-closed and it was documented
-- — RLS default-denies every operation with no policy — but it made this the only
-- table in the repo with an incomplete policy set, and "the odd one out is fine,
-- there's a comment" is exactly how a genuinely missing policy stops being
-- noticeable. PLAN.md's RLS strategy rule 1 is explicit that job tables get four
-- like everything else.
--
-- What actually changes at runtime: almost nothing. Heartbeats are written by the
-- Inngest health-check function through `createAdminSupabaseClient`, which bypasses
-- RLS, so these policies grant reach to browsers rather than to the job. The reason
-- to add them anyway is uniformity — a table with four owner-scoped policies is
-- unremarkable, and unremarkable is what lets an anomaly stand out.
--
-- The honest cost of doing this: an authenticated browser can now forge, edit and
-- delete heartbeat rows under its own user_id. Heartbeats are transient round-trip
-- proof (the function deletes its own row before returning), nothing reads them to
-- make a decision, and a user forging their own heartbeat only deceives themselves.
-- That is an acceptable price for uniformity here; it would NOT be on a table whose
-- contents gate anything.

create policy "Users can insert own job heartbeats"
  on public.job_heartbeats
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update own job heartbeats"
  on public.job_heartbeats
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete own job heartbeats"
  on public.job_heartbeats
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);
