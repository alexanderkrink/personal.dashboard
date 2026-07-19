-- Two structural guarantees for syllabus extraction (M1 item 11).
--
-- Both exist because the writer is a **service-role client**, which bypasses RLS
-- and never passes through a Server Action. Wave 2 proved twice that an
-- invariant living only in application code is an invariant that a background
-- job will eventually walk straight through.

/* ────────────────────────────────────────────────────────────────────────── */
/* 1. Grade-critical rows are never BORN active                               */
/* ────────────────────────────────────────────────────────────────────────── */

-- `assessments.confirmed` defaults to **true**, which is right for the manual
-- path — a weight the user typed is confirmed by the act of typing it. It is
-- exactly wrong for an extraction, and the gap between those two is a single
-- forgotten field on an insert.
--
-- PLAN.md §2b reserves grade weights as one of only two mandatory human-confirm
-- classes: "a wrong weight silently corrupts every 'what do I need on the final'
-- answer, so it is never born active." That sentence is a promise about the
-- data, not about the diligence of whoever writes the next inserter — so it is
-- enforced here, where the service-role client cannot get around it.
--
-- BEFORE INSERT only. Confirming is an UPDATE and stays untouched, which is the
-- whole point: the row can be promoted, it just cannot start promoted.
create function public.force_syllabus_extract_unconfirmed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.source = 'syllabus_extract' then
    new.confirmed := false;
  end if;
  return new;
end;
$$;

comment on function public.force_syllabus_extract_unconfirmed() is
  'Forces confirmed = false on any assessments row inserted with source = ''syllabus_extract''. PLAN.md §2b: grade weights are a reserved human-confirm class and are never born active. Enforced in the database because the extraction writer is a service-role client that bypasses RLS and Server Actions alike.';

create trigger assessments_syllabus_extract_unconfirmed
  before insert on public.assessments
  for each row
  execute function public.force_syllabus_extract_unconfirmed();

/* ────────────────────────────────────────────────────────────────────────── */
/* 2. An extraction lands whole, or not at all                                */
/* ────────────────────────────────────────────────────────────────────────── */

-- The write spans three tables: the run, one `assessments` row per component,
-- and one provenance row per assessment. PostgREST gives no transaction across
-- three round trips, and the partial state is not merely untidy — it is the
-- specific failure the confirm gate exists to prevent.
--
-- An `assessments` row whose `syllabus_extraction_components` row never landed
-- is an unconfirmed grade weight **with no source snippet**, and the confirm
-- screen has nothing to show beside it. That degrades the review step to exactly
-- the rubber-stamping PLAN.md §Grade Cockpit (c) calls out. One statement, one
-- transaction, and that state cannot exist.
--
-- `security invoker` (the default) is deliberate and needs no justification
-- comment: the inserts run as the caller, so RLS still applies to a session user
-- and a service-role caller is trusted exactly as much as it already was. There
-- is no privilege escalation here — only atomicity.
create function public.apply_syllabus_extraction(
  p_user_id uuid,
  p_course_id uuid,
  p_source_label text,
  p_extracted_course_title text,
  p_proposed_total_sessions int,
  p_total_sessions_evidence text,
  p_notes text,
  p_prompt_id text,
  p_prompt_version int,
  p_provider text,
  p_model text,
  p_input_hash text,
  p_components jsonb
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_extraction_id uuid;
  v_component jsonb;
  v_assessment_id uuid;
begin
  insert into public.syllabus_extractions (
    user_id, course_id, source_label, extracted_course_title,
    proposed_total_sessions, total_sessions_evidence, notes,
    prompt_id, prompt_version, provider, model, input_hash
  )
  values (
    p_user_id, p_course_id, p_source_label, p_extracted_course_title,
    p_proposed_total_sessions, p_total_sessions_evidence, p_notes,
    p_prompt_id, p_prompt_version, p_provider, p_model, p_input_hash
  )
  returning id into v_extraction_id;

  for v_component in select * from jsonb_array_elements(p_components)
  loop
    -- `confirmed` is not passed: the trigger above forces it false, and naming
    -- it here would suggest this function is what guarantees it. It isn't.
    insert into public.assessments (
      user_id, course_id, title, kind, weight_percent, session_number, source
    )
    values (
      p_user_id,
      p_course_id,
      v_component ->> 'title',
      v_component ->> 'kind',
      (v_component ->> 'weight_percent')::numeric,
      nullif(v_component ->> 'session_number', '')::int,
      'syllabus_extract'
    )
    returning id into v_assessment_id;

    insert into public.syllabus_extraction_components (
      user_id, extraction_id, assessment_id, source_snippet, session_note
    )
    values (
      p_user_id,
      v_extraction_id,
      v_assessment_id,
      v_component ->> 'source_snippet',
      v_component ->> 'session_note'
    );
  end loop;

  return v_extraction_id;
end;
$$;

comment on function public.apply_syllabus_extraction is
  'Persists one syllabus-components run atomically: the extraction row, one unconfirmed assessments row per proposed component, and the provenance row carrying each source snippet. Returns the extraction id. Atomic because a half-landed extraction means an unconfirmed grade weight with no snippet to confirm it against, which is the exact state the mandatory confirm gate exists to prevent.';
