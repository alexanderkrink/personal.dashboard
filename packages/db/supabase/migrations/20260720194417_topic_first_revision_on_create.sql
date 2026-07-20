-- A topic can no longer exist without its first revision.
--
-- ## The defect this closes
--
-- `persistTopicMerge`'s create branch inserted the topic and returned. It never wrote a
-- `topic_revisions` row, so `verified.needsReview` — computed on every merge, including the
-- Wave 5 grounding checks (ungrounded formulas, unanchored key terms) and the expansion-ratio
-- gate — was **discarded on every first merge**. `needs_review` is a column on
-- `topic_revisions` and nowhere else, so a newly created topic had no place to carry it.
--
-- That is precisely backwards. The two guards were built for the Wave 4 failure: a thin
-- input producing an ungrounded, newly created topic in a course with no topics. That is the
-- CREATE path. The topic most likely to be ungrounded was the only one structurally
-- incapable of being flagged.
--
-- It is the fourth instance of one pattern — the create path being the unchecked path.
-- Loss-detector checks 1-3 iterate `before`, which is the empty page on a create.
-- `topic_revisions` was empty despite `topics.revision = 1`. The History drawer had nothing
-- to render. And this.
--
-- ## Why revision ZERO, and why the existing precedent is wrong
--
-- A `topic_revisions` row holds the page as it was BEFORE the merge stamped on it — that is
-- what makes a revert a copy rather than a reconstruction. A create supersedes the empty
-- page, and the empty page is revision 0. The create then leaves `topics.revision = 1`.
--
-- `createAuditTopic` (`apps/web/src/inngest/topic-edits.ts`) already writes a first-revision
-- row for a brand-new topic, but at `revision: 1`. That is subtly wrong and this migration
-- does not adopt it: the NEXT merge into that topic reads `currentRevision = 1` and tries to
-- snapshot at revision 1 as well, which collides with `unique (topic_id, revision)` — and
-- `route-and-merge.ts` swallows 23505 on that insert as "this step already ran", so the
-- second merge's snapshot is silently lost. Revision 0 for the create keeps every subsequent
-- revision number free.
--
-- The `check (revision >= 1)` below is the reason the create path could not simply write the
-- row it should always have written. Widening it is what makes revision 0 expressible.
--
-- ## Why the invariant is in the database
--
-- PostgREST calls are separate transactions, so "insert the topic, then insert the revision"
-- from the application can be interrupted between the two and leave exactly the state this
-- migration exists to forbid. A deferred constraint cannot help across transactions. The
-- only way for the two writes to be atomic is for them to be ONE statement, which is what
-- the function at the bottom is for.
--
-- Safe to apply as written: the check is widened, never narrowed, so no existing row can
-- violate it; the new column is additive with a default; the function is new.

/* ========================================================================== */
/* 1. Revision 0 becomes expressible                                          */
/* ========================================================================== */

alter table public.topic_revisions
  drop constraint topic_revisions_revision_check;

alter table public.topic_revisions
  add constraint topic_revisions_revision_check check (revision >= 0);

comment on column public.topic_revisions.revision is
  'The revision this row snapshots — the page as it was BEFORE the merge stamped on this row. Zero is the empty page a topic''s creating merge superseded, so a created topic has a revision-0 row and lands at topics.revision = 1.';

/* ========================================================================== */
/* 2. Somewhere for the findings to live, not just the boolean                */
/* ========================================================================== */

-- `needs_review` says a merge was flagged. It does not say why, and "why" is the part a
-- person can act on: "this page states 6 formulas the source never displayed" is actionable
-- where a bare chip is only alarming. The verifier already computes these strings and threw
-- them away.
alter table public.topic_revisions
  add column review_notes text[] not null default '{}';

comment on column public.topic_revisions.review_notes is
  'Why this merge was flagged: the loss-detector, grounding and critic findings, one per entry, already rendered for a human. Empty when needs_review is false. Never a substitute for needs_review — a flagged revision with no notes is still flagged.';

/* ========================================================================== */
/* 3. Topic + first revision, atomically                                      */
/* ========================================================================== */

-- `security invoker` (the default) on purpose. The only caller is an Inngest job holding the
-- service key, for which RLS is not in the path; under any other role the two inserts are
-- RLS-checked exactly as they would be if the caller had issued them directly. Nothing here
-- needs a privilege the caller does not already have, so nothing here justifies
-- `security definer`.
--
-- `p_previous_page` rather than a hardcoded '{}': the shape of an empty TopicPage is the
-- application's business (`EMPTY_TOPIC_PAGE`), and a database function inventing its own
-- version of it would drift the moment the page schema gains a block family.
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
  p_input_hash text
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
    p_user_id, new_topic_id, 0, p_previous_page, p_change_summary, 'merge',
    p_needs_review, coalesce(p_review_notes, '{}'), p_document_id,
    p_prompt_id, p_prompt_version, p_provider, p_model, p_input_hash
  );

  return new_topic_id;
end;
$$;

comment on function public.create_topic_with_first_revision is
  'Creates a topic and its revision-0 snapshot in one statement, so a topic can never exist without the first revision that carries its needs_review flag and review notes. Background merge path only.';

-- Background jobs only, enforced rather than documented. Topic creation from a merge is not
-- something a signed-in session performs, and the grant is the cheapest place to say so.
revoke execute on function public.create_topic_with_first_revision from public;
revoke execute on function public.create_topic_with_first_revision from anon;
revoke execute on function public.create_topic_with_first_revision from authenticated;
grant execute on function public.create_topic_with_first_revision to service_role;
