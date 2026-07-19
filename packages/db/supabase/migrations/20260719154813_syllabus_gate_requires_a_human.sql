-- The §2b confirm gate needs a HUMAN, and until now it only needed a client.
--
-- ## What was wrong
--
-- `confirm_syllabus_extraction` and `reject_syllabus_extraction` are
-- `security invoker`, and the comment in `20260719122153` reasoned that this was
-- enough: "RLS applies, so another account's extraction is simply not visible".
-- That sentence is true of a *session* caller and completely false of the one
-- caller this codebase actually runs background work through. A service-role
-- client bypasses RLS entirely, so for it "not visible" was never a constraint —
-- every extraction in the project was visible, and confirming any of them was
-- one RPC call.
--
-- ⚠ MEASURED, not reasoned, 2026-07-19 against project fvqnscvqysxreetwstgr:
-- a `createClient(url, SUPABASE_SECRET_KEY)` round trip through PostgREST called
-- `confirm_syllabus_extraction` on a freshly created fixture extraction and got
-- back `error: null`. The proposed `assessments` row flipped
-- `confirmed: false → true` and `courses.total_sessions` went `null → 99` with
-- `total_sessions_source = 'syllabus'`. No human, no session, no auth.uid().
--
-- PLAN.md §AI Strategy §2b reserves exactly two mandatory-human-confirm classes,
-- and grade-critical weights are one of them: "a wrong weight silently corrupts
-- every 'what do I need on the final' answer, so it is never born active."
-- `20260719121909` spent a whole migration making sure such a row cannot be
-- BORN active — and then left the door that makes it active standing open to the
-- very client that migration was defending against. Half a gate is not a gate.
--
-- ## The fix
--
-- `auth.uid()` returns the `sub` claim of the request JWT. A service-role client
-- sends a JWT whose role is `service_role` and which carries no `sub`, so
-- `auth.uid()` is NULL for it — reliably, and without the function needing to
-- know anything about roles, keys or PostgREST. "There is a signed-in human on
-- the other end of this call" is therefore expressible as a one-line assertion,
-- and it is enforced in the database, where a service-role writer cannot route
-- around it.
--
-- ## Scope: the whole gate, not just `confirm`
--
-- BOTH outcomes are guarded, because §2b's gate is not "confirm is special" —
-- it is "this decision belongs to a person". `reject` deletes the proposed
-- `assessments` rows outright; a background job that could reject could silently
-- discard a proposal the user was about to review, and the user would never know
-- there had been one. Confirm corrupts the grade projection, reject erases the
-- evidence. Neither is a decision a job gets to make.
--
-- ## What is deliberately NOT guarded: `apply_syllabus_extraction`
--
-- That function is the *designated* service-role writer — it is how the
-- extraction job persists a proposal at all, and everything it inserts is
-- unconfirmed by force of the `20260719121909` trigger. Adding the same
-- assertion there would break the only legitimate caller and close nothing:
-- creating an unconfirmed proposal is precisely the operation §2b wants a
-- machine to do. It gets a different, weaker hardening below.

/* ────────────────────────────────────────────────────────────────────────── */
/* The assertion                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

-- Factored out rather than inlined twice so the gate has ONE definition. Two
-- copies of a security check drift, and the copy that drifts is the one nobody
-- re-reads.
--
-- `stable`, not `volatile`: it reads only the request JWT. `security invoker`
-- (the default) is essential — a `security definer` wrapper would evaluate
-- `auth.uid()` in the definer's context and could not see the caller at all,
-- which would invert the check it exists to perform.
create function public.assert_human_caller(p_action text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception
      'Action "%" requires a signed-in user. This is a mandatory human-confirm gate (PLAN.md AI Strategy 2b); a service-role or otherwise session-less caller may not make this decision.', p_action
      using errcode = 'insufficient_privilege';
  end if;
end;
$$;

comment on function public.assert_human_caller(text) is
  'Raises insufficient_privilege when auth.uid() is NULL — i.e. when the caller is a service-role or otherwise session-less client rather than a signed-in person. The database-side half of PLAN.md 2b''s mandatory human-confirm gate. security invoker is required: a definer wrapper could not see the caller''s JWT.';

/* ────────────────────────────────────────────────────────────────────────── */
/* confirm — unchanged except for the gate                                    */
/* ────────────────────────────────────────────────────────────────────────── */

create or replace function public.confirm_syllabus_extraction(p_extraction_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_extraction public.syllabus_extractions;
begin
  -- FIRST, before the row is even looked up. A session-less caller must not be
  -- able to tell a real extraction id from a made-up one by the error it gets
  -- back: ordering the checks the other way would turn this function into an id
  -- oracle for a client that has no business knowing any of them.
  perform public.assert_human_caller('confirm_syllabus_extraction');

  -- RLS applies (security invoker): another account's extraction is simply not
  -- visible here, so this is a not-found rather than a permission error. True
  -- now that the line above has established there IS an account.
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
  'Promotes a whole syllabus extraction: flips its assessments rows to confirmed, writes the proposed session count to courses with total_sessions_source = ''syllabus'' (the PRIMARY oracle per 5.1b, so it overwrites a feed_derived value), and stamps confirmed_at. Atomic: a partial confirm can activate grade weights while the session count from the same document never lands. Requires a signed-in caller (assert_human_caller) — RLS alone does not constrain the service-role client, which was able to confirm any extraction in the project until 2026-07-19.';

/* ────────────────────────────────────────────────────────────────────────── */
/* reject — the same gate, plus the not-found it never had                    */
/* ────────────────────────────────────────────────────────────────────────── */

create or replace function public.reject_syllabus_extraction(p_extraction_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform public.assert_human_caller('reject_syllabus_extraction');

  -- Added here, matching `confirm`. The original silently succeeded on an id it
  -- could not see, so the Server Action reported "discarded" for a proposal that
  -- was still sitting there — the one failure mode a destructive action must not
  -- have. Cheap now that the caller is known to be a session user.
  perform 1
  from public.syllabus_extractions
  where id = p_extraction_id;

  if not found then
    raise exception 'Syllabus extraction % not found', p_extraction_id;
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
  'Discards a syllabus extraction: deletes the assessments rows it proposed (provenance rows cascade) and the run itself. Never touches courses — a rejected extraction never wrote a session count, which is why proposed_total_sessions waits on the run. Requires a signed-in caller (assert_human_caller): rejecting erases a proposal before the human ever sees it, which is the same 2b decision as confirming.';

/* ────────────────────────────────────────────────────────────────────────── */
/* apply — defence in depth, not a gate                                       */
/* ────────────────────────────────────────────────────────────────────────── */

-- `p_user_id` is a free parameter on the function that stamps ownership on
-- every row it writes. For a service-role caller that is by design: the job has
-- no session and the event tells it whose work this is. For a *session* caller
-- it is a loose end — RLS does reject the mismatched insert, but it rejects it
-- three tables deep with a policy-violation error, and "the outer layer happens
-- to catch it" is exactly the reasoning that left the confirm gate open.
--
-- So: when there IS a session, `p_user_id` must be that session's user. When
-- there is not (auth.uid() IS NULL, the service-role job path), the parameter
-- stands as before and nothing about the legitimate caller changes.
create or replace function public.apply_syllabus_extraction(
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
  v_caller uuid := (select auth.uid());
begin
  if v_caller is not null and v_caller is distinct from p_user_id then
    raise exception
      'apply_syllabus_extraction: p_user_id % does not match the calling session %', p_user_id, v_caller
      using errcode = 'insufficient_privilege';
  end if;

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
    -- `confirmed` is not passed: the trigger forces it false, and naming it here
    -- would suggest this function is what guarantees it. It isn't.
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
  'Persists one syllabus-components run atomically: the extraction row, one unconfirmed assessments row per proposed component, and the provenance row carrying each source snippet. Returns the extraction id. Deliberately NOT behind assert_human_caller — creating an unconfirmed proposal is exactly what a background job should do. A session caller must pass its own auth.uid() as p_user_id; a session-less (service-role) caller supplies the owner from the event, as before.';
