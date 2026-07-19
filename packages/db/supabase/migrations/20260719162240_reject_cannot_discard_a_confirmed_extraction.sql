-- `reject_syllabus_extraction` could delete CONFIRMED grade weights and orphan
-- the session count that came with them.
--
-- ## What was wrong
--
-- `20260719154813` gated both outcomes behind `assert_human_caller` and, in the
-- same breath, wrote this on `reject`:
--
--   "Never touches courses — a rejected extraction never wrote a session count,
--    which is why proposed_total_sessions waits on the run."
--
-- The second clause is an assertion about a state the function never checked.
-- `reject` looked the extraction up, found it, and deleted — without ever asking
-- whether it had already been CONFIRMED. A confirmed extraction most certainly
-- did write a session count: `confirm` sets `courses.total_sessions` and stamps
-- `total_sessions_source = 'syllabus'`.
--
-- ⚠ MEASURED, not reasoned, 2026-07-19 against project fvqnscvqysxreetwstgr, in a
-- transaction that was rolled back. Calling `reject_syllabus_extraction` on the
-- fixture account's CONFIRMED extraction (`2f40c16a…`, confirmed_at 12:33) as a
-- signed-in session user returned success and left:
--
--   * extraction rows remaining: 0   (the run and its provenance, gone)
--   * assessments remaining:     0   (all four CONFIRMED weights, deleted)
--   * courses.total_sessions:    30, total_sessions_source: 'syllabus'  (UNCHANGED)
--
-- So the course kept a session count sourced from a syllabus run that no longer
-- exists — unfalsifiable provenance, because the evidence it points at was the
-- thing deleted — and four confirmed grade weights vanished. That is precisely
-- the corruption PLAN.md §2b's gate exists to prevent, arriving through the gate's
-- own other door.
--
-- ## Why this is reachable, not theoretical
--
-- `courses/[id]/page.tsx` renders the confirm/discard panel only for extractions
-- with `confirmed_at is null`, so the UI never *offers* this. But the panel is a
-- form, and `syllabus-actions.ts` re-checks nothing: it takes `extractionId` from
-- the submitted `FormData` and calls the RPC. Two tabs on the same course is all
-- it takes — confirm in the first, then click Discard in the second, which still
-- has the pre-confirm panel rendered. The Server Action's own not-found copy
-- ("It may have been resolved in another tab") shows that stale tabs were
-- anticipated; only the not-found half of that race was handled.
--
-- ## The fix, and why it belongs here rather than in the Server Action
--
-- A service-role writer bypasses RLS and Server Actions alike, and `reject` is
-- reachable as a bare RPC by any session client. A guard added to
-- `syllabus-actions.ts` would protect one caller and describe an invariant the
-- database does not hold. The database is where "a confirmed run cannot be
-- discarded" has to be true.
--
-- ## Why REFUSE rather than also revert `courses`
--
-- Reverting is not implementable correctly. `confirm` overwrites whatever was in
-- `courses.total_sessions` — commonly a `feed_derived` value (7 of 8 rows carrying
-- one in this project today) — and records nothing about what it displaced. There
-- is no prior value to restore, so a "revert" would have to invent one, and
-- inventing a number is the failure mode `20260719155004` refused for cost and
-- `pricing.ts` refuses for rates. Refusing keeps the migration honest: confirming
-- is a decision the user made, and undoing it is editing, which the per-row
-- assessment editor already does.
--
-- `object_not_in_prerequisite_state` (55000) rather than a generic raise: this is
-- a state error, not a bad argument and not a permission problem, and a caller
-- that wants to tell it apart from `assert_human_caller`'s
-- `insufficient_privilege` can now do so by code.

create or replace function public.reject_syllabus_extraction(p_extraction_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_confirmed_at timestamptz;
begin
  perform public.assert_human_caller('reject_syllabus_extraction');

  -- One lookup, two questions: does it exist, and is it still a proposal?
  -- `select into` sets FOUND on row match, independently of the column being NULL
  -- — and NULL is exactly the value that means "still unconfirmed" here, so the
  -- two must not be conflated.
  select confirmed_at into v_confirmed_at
  from public.syllabus_extractions
  where id = p_extraction_id;

  if not found then
    raise exception 'Syllabus extraction % not found', p_extraction_id;
  end if;

  if v_confirmed_at is not null then
    raise exception
      'Syllabus extraction % was confirmed at % and can no longer be discarded. Rejecting it would delete grade weights the user confirmed and strand courses.total_sessions on a run that no longer exists; edit the assessments instead.', p_extraction_id, v_confirmed_at
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  delete from public.assessments a
  using public.syllabus_extraction_components c
  where c.assessment_id = a.id
    and c.extraction_id = p_extraction_id;

  delete from public.syllabus_extractions
  where id = p_extraction_id;
end;
$$;

comment on function public.reject_syllabus_extraction is
  'Discards an UNCONFIRMED syllabus extraction: deletes the assessments rows it proposed (provenance rows cascade) and the run itself. Refuses a confirmed one with object_not_in_prerequisite_state — confirm writes courses.total_sessions and reject cannot un-write it, so allowing the pair would delete confirmed grade weights and leave the course claiming a syllabus-sourced session count whose run is gone. Requires a signed-in caller (assert_human_caller): rejecting erases a proposal before the human ever sees it, which is the same PLAN.md 2b decision as confirming.';
