-- `create_topic_with_first_revision` learns whose revision it writes.
--
-- ## Why
--
-- `createAuditTopic` (apps/web/src/inngest/topic-edits.ts) creates a topic from a deep-review
-- `missing` finding. It used to do so with two separate PostgREST inserts, writing its first
-- revision at revision 1 — the latent bug `20260720194417`'s header records: the NEXT merge
-- into that topic reads `currentRevision = 1`, snapshots at revision 1, collides with
-- `unique (topic_id, revision)`, and `route-and-merge.ts` swallows that 23505 as "this step
-- already ran" — so the merge's pre-merge snapshot (the only durable copy of the page as the
-- audit wrote it) is silently lost.
--
-- The fix is to route the audit create through this RPC, exactly as the merge create path
-- does: topic + revision-0 snapshot in ONE statement, every later revision number free. The
-- one thing the function could not express is attribution: it hardcoded
-- `source = 'merge'`, and an audit-created topic must carry `source = 'deep_review'` so the
-- History drawer says "Deep review added this topic" rather than crediting a lecture — and
-- so `loadPriorContributions` (which filters `source = 'merge'`) does not mistake the
-- audit's create record for a prior merge contribution of that document.
--
-- ## Shape of the change
--
-- Postgres cannot alter a function's parameter list in place, and `create or replace` with
-- an extra parameter would create an OVERLOAD — two functions with one name, which PostgREST
-- RPC resolution then refuses as ambiguous. So: drop, recreate with `p_source` appended.
--
-- `p_source text default 'merge'` — a default, so the existing caller
-- (`persistTopicMerge`'s create branch) is untouched: PostgREST resolves named-argument
-- calls against defaults, and the merge path keeps meaning 'merge' without restating it.
-- The value lands in `topic_revisions.source`, whose existing check constraint
-- (`source in ('merge', 'deep_review', 'revert')`) remains the validity guard; this
-- function adds no second copy of that rule to drift from the first.
--
-- Safe to apply as written: drop + recreate of a function nothing calls mid-migration, no
-- table or row is touched, and the recreated body is identical except for the one column
-- now being a parameter.

drop function public.create_topic_with_first_revision(
  uuid, uuid, text, text, text, jsonb, jsonb, text, boolean, text[], uuid, text, int, text, text, text
);

-- `security invoker` (the default) on purpose, unchanged from `20260720194417`: the only
-- caller is an Inngest job holding the service key, for which RLS is not in the path; under
-- any other role the two inserts are RLS-checked exactly as if issued directly. Nothing here
-- needs a privilege the caller does not already have.
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
  p_source text default 'merge'
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  new_topic_id uuid;
begin
  insert into public.topics (user_id, course_id, title, slug, summary, page, revision)
  values (p_user_id, p_course_id, p_title, p_slug, p_summary, p_page, 1)
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
  'Creates a topic and its revision-0 snapshot in one statement, so a topic can never exist without the first revision that carries its needs_review flag and review notes. p_source attributes the creation (merge for the pipeline, deep_review for the audit); topic_revisions'' check constraint is the validity guard. Background job paths only.';

-- Background jobs only, enforced rather than documented — restated because the drop above
-- discarded the old function's ACL along with it.
revoke execute on function public.create_topic_with_first_revision from public;
revoke execute on function public.create_topic_with_first_revision from anon;
revoke execute on function public.create_topic_with_first_revision from authenticated;
grant execute on function public.create_topic_with_first_revision to service_role;
