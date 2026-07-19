-- Resolving a syllabus extraction: the human confirm gate's two outcomes (M1 item 11).
--
-- Both are atomic for the same reason the write path is. Confirming touches
-- three things — the assessments rows, `courses.total_sessions`, and the run's
-- own `confirmed_at` — and a partial confirm is not a cosmetic problem: it can
-- leave grade weights active while the session count that came from the SAME
-- document never lands, so the exam chain keeps reading a feed-derived number
-- that the user believes they just replaced.

/* ────────────────────────────────────────────────────────────────────────── */
/* confirm — promote the whole proposal                                       */
/* ────────────────────────────────────────────────────────────────────────── */

-- This is the moment a syllabus-derived session count becomes DISTINGUISHABLE
-- from a feed-derived one. PLAN.md §5.1b records that all 7 courses currently
-- read `total_sessions_source = 'feed_derived'`, which is exactly why exam
-- detection is circular today: step 1 (the "syllabus oracle") and step 3 (the
-- `max(sessionTo)` fallback) read the same number by two routes. Writing
-- 'syllabus' here is what breaks that tie — and per the same section, the
-- syllabus is the PRIMARY oracle, so it overwrites a feed-derived value rather
-- than deferring to it.
create function public.confirm_syllabus_extraction(p_extraction_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_extraction public.syllabus_extractions;
begin
  -- RLS applies (security invoker): another account's extraction is simply not
  -- visible here, so this is a not-found rather than a permission error.
  select * into v_extraction
  from public.syllabus_extractions
  where id = p_extraction_id;

  if not found then
    raise exception 'Syllabus extraction % not found', p_extraction_id;
  end if;

  update public.assessments a
  set confirmed = true
  from public.syllabus_extraction_components c
  where c.assessment_id = a.id
    and c.extraction_id = p_extraction_id;

  if v_extraction.proposed_total_sessions is not null then
    update public.courses
    set total_sessions = v_extraction.proposed_total_sessions,
        total_sessions_source = 'syllabus'
    where id = v_extraction.course_id;
  end if;

  update public.syllabus_extractions
  set confirmed_at = now()
  where id = p_extraction_id;
end;
$$;

comment on function public.confirm_syllabus_extraction is
  'Promotes a whole syllabus extraction: flips its assessments rows to confirmed, writes the proposed session count to courses with total_sessions_source = ''syllabus'' (the PRIMARY oracle per §5.1b, so it overwrites a feed_derived value), and stamps confirmed_at. Atomic: a partial confirm can activate grade weights while the session count from the same document never lands.';

/* ────────────────────────────────────────────────────────────────────────── */
/* reject — discard it, leaving no trace to mistake for real data             */
/* ────────────────────────────────────────────────────────────────────────── */

-- Deleting the assessments rows is what actually clears the proposal; the
-- provenance rows follow by `on delete cascade` from both sides. Nothing here
-- touches `courses`, because a rejected extraction never wrote to it — which is
-- the entire reason `proposed_total_sessions` waits on the run instead.
create function public.reject_syllabus_extraction(p_extraction_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  delete from public.assessments a
  using public.syllabus_extraction_components c
  where c.assessment_id = a.id
    and c.extraction_id = p_extraction_id;

  delete from public.syllabus_extractions
  where id = p_extraction_id;
end;
$$;

comment on function public.reject_syllabus_extraction is
  'Discards a syllabus extraction: deletes the assessments rows it proposed (provenance rows cascade) and the run itself. Never touches courses — a rejected extraction never wrote a session count, which is why proposed_total_sessions waits on the run.';
