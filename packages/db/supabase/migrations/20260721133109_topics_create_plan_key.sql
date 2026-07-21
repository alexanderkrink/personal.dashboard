-- A durable, atomic link from a created topic back to the plan target that created it
-- (Wave 7 §3 blocker fix).
--
-- ## The defect this closes
--
-- The resumable merge path (runRouteAndMergeSteps) resolved a create target on a re-entry via
-- `document_merge_plans.plan.targets[].resolvedTopicId`, written by the BEST-EFFORT
-- `recordResolvedCreate` AFTER `create_topic_with_first_revision` had already committed. If
-- that write-back is lost — its UPDATE error is swallowed, or the worker dies in the window
-- between the committed create and the write-back — then a FRESH Inngest run (the
-- "Retry the rest" button, where step memoization does NOT carry over) loads the frozen plan
-- with that target still `topicId=null` and no `resolvedTopicId`. It builds a CREATE target;
-- `planMergeWork` unconditionally sends any null-topicId target to `toMerge` (it never
-- consults prior contributions for a create); and `create_topic_with_first_revision` runs a
-- SECOND time. `slugFor` uniquifies the slug so `unique (course_id, slug)` does not object,
-- and `topic_revisions_one_merge_per_document` is keyed on (topic_id, document_id) — the
-- duplicate has a brand-new topic_id, so the trigger passes. Because the resumable path loads
-- the frozen plan and routes zero times, the duplicate guard in `runRouting` — the only thing
-- that collapsed this in the old single-step path — never runs. Result: two topic pages with
-- the same content.
--
-- ## The fix
--
-- Stamp the plan's stable target key onto the created topic ATOMICALLY, inside the same
-- statement that inserts the topic and its revision-0 snapshot — so the marker is present iff
-- the topic exists, closing every crash window including the one between the committed create
-- and the (now merely fast-path) write-back. On a re-entry, a create target lacking a
-- resolution is looked up deterministically by this marker; a hit resolves it to an
-- assign/skip instead of a second create.
--
-- `create_plan_key` stores the DOCUMENT-QUALIFIED key `<document_id>:<plan target key>`, so it
-- is globally unique without a second column: segment keys reset per document, and two
-- documents in one course can each own a `new:seg-1` target. It is an opaque internal resume
-- marker rather than a typed reference, so it carries no FK; tenancy is enforced by the
-- topics row's own user_id/course_id, which every lookup already filters on. Null for topics
-- not created by the pipeline's merge path (the deep-review audit create passes no key).
--
-- Safe to apply as written: the column is additive and nullable with no default backfill, and
-- the function is dropped + recreated (Postgres cannot add a parameter in place without
-- creating an ambiguous overload — the same move 20260720213410 documents), nothing calls it
-- mid-migration.

/* ========================================================================== */
/* 1. The durable marker                                                      */
/* ========================================================================== */

alter table public.topics
  add column create_plan_key text;

comment on column public.topics.create_plan_key is
  'Wave 7 §3 durable resume marker: <document_id>:<frozen plan target key> of the create that produced this topic, written atomically with the topic by create_topic_with_first_revision. On a re-entry a create target lacking a resolution is looked up by this key and resolved to a skip instead of a duplicate create. Null for non-pipeline creates (the deep-review audit).';

-- UNIQUE, so create-idempotency is a STRUCTURAL invariant rather than resting on the app's
-- `findCreatedTopic` lookup and the per-course concurrency lane alone: the database itself
-- refuses a second topic carrying the same marker. A losing race (or a retry that raced its
-- own prior attempt) hits 23505 instead of duplicating; the app catches it and resolves to the
-- winner. Two NULL markers do not collide (the partial predicate excludes them), so the
-- deep-review audit create — which passes no key — is unconstrained. Scoped by
-- (user_id, course_id) to match `findCreatedTopic`'s filter, which also makes that lookup's
-- `.maybeSingle()` structurally unable to see more than one row.
create unique index topics_create_plan_key_idx
  on public.topics (user_id, course_id, create_plan_key)
  where create_plan_key is not null;

/* ========================================================================== */
/* 2. create_topic_with_first_revision learns the plan key                    */
/* ========================================================================== */

-- Drop + recreate rather than `create or replace`: adding a parameter to a function creates
-- an OVERLOAD, which PostgREST RPC resolution then refuses as ambiguous (see the note in
-- 20260720213410). Nothing calls the function mid-migration.
drop function public.create_topic_with_first_revision(
  uuid, uuid, text, text, text, jsonb, jsonb, text, boolean, text[], uuid, text, int, text, text, text, text
);

-- `security invoker` (the default) unchanged: the only caller is an Inngest job holding the
-- service key, for which RLS is not in the path; under any other role the inserts are
-- RLS-checked exactly as if issued directly.
--
-- `p_create_plan_key text default null` appended last, so the deep-review audit create
-- (createAuditTopic, which passes p_source but no key) resolves against the default and lands
-- a null marker — correct, because the resume lookup requires a non-null key and never
-- matches an audit-created topic.
create function public.create_topic_with_first_revision(
  p_user_id uuid,
  p_course_id uuid,
  p_title text,
  p_slug text,
  p_summary text,
  p_page jsonb,
  p_previous_page jsonb,
  p_change_summary text,
  p_needs_review boolean,
  p_review_notes text[],
  p_document_id uuid,
  p_prompt_id text,
  p_prompt_version int,
  p_provider text,
  p_model text,
  p_input_hash text,
  p_source text default 'merge',
  p_create_plan_key text default null
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  new_topic_id uuid;
begin
  insert into public.topics (
    user_id, course_id, title, slug, summary, page, revision, create_plan_key
  )
  values (p_user_id, p_course_id, p_title, p_slug, p_summary, p_page, 1, p_create_plan_key)
  returning id into new_topic_id;

  insert into public.topic_revisions (
    user_id, topic_id, revision, page, change_summary, source,
    needs_review, review_notes, document_id,
    prompt_id, prompt_version, provider, model, input_hash
  )
  values (
    p_user_id, new_topic_id, 0, p_previous_page, p_change_summary, p_source,
    p_needs_review, coalesce(p_review_notes, '{}'), p_document_id,
    p_prompt_id, p_prompt_version, p_provider, p_model, p_input_hash
  );

  return new_topic_id;
end;
$$;

comment on function public.create_topic_with_first_revision is
  'Creates a topic and its revision-0 snapshot in one statement, so a topic can never exist without the first revision that carries its needs_review flag and review notes. p_source attributes the creation; p_create_plan_key stamps the Wave 7 §3 durable resume marker atomically with the create. Background job paths only.';

-- Background jobs only, restated because the drop above discarded the old function's ACL.
revoke execute on function public.create_topic_with_first_revision from public;
revoke execute on function public.create_topic_with_first_revision from anon;
revoke execute on function public.create_topic_with_first_revision from authenticated;
grant execute on function public.create_topic_with_first_revision to service_role;
