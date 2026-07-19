-- Make a second merge of the same document into the same topic impossible.
--
-- ## The defect this closes
--
-- PLAN §5's "Idempotency & re-processing" paragraph claims a re-run first STRIPS the
-- document's prior contributions — replaying each topic forward from its pre-merge
-- `topic_revisions` snapshot and deleting the `topic_sources` rows. That strip was never
-- built (PLAN is marked 🔴 DISPROVEN 2026-07-20). Without it, a second pass over an
-- already-merged document compounds instead of converging:
--
--   `runRouteAndMerge` re-reads `topics.revision` fresh, so `target.currentRevision` is the
--   value the FIRST pass already bumped. The `unique (topic_id, revision)` guard on
--   topic_revisions — documented in route-and-merge.ts as what makes the persist idempotent
--   — therefore cannot fire, because the write it protects against is the one that moved the
--   key. Each pass appends another revision row, bumps `topics.revision` again, re-bills the
--   merge + critic calls, and hands the merge prompt a page that already contains this
--   document's own contribution alongside the same segments a second time.
--
-- Two real triggers: the "Retry the rest" button on a partial/failed document, and any
-- Inngest step retry landing after at least one topic has persisted (the merge step makes
-- 2+ serial LLM calls per topic and `retries: 3` is live).
--
-- ## Why the invariant is in the database
--
-- The only writer on this path is an Inngest job holding the service key, so RLS and Server
-- Actions are both out of the picture. An application-side "have I already merged this?"
-- check is a cost optimisation; it is not an invariant, because the next writer can forget
-- it. The trigger below is the invariant.
--
-- ## The key
--
-- `topic_sources` already carries `unique (topic_id, document_id)` — the Gate 1 F4
-- idempotency key. What it was missing is WHICH REVISION that merge produced. With
-- `merged_at_revision` recorded, "document D is already merged into topic T, and the merge
-- that did it left T at revision R" becomes a stored fact, and a second merge revision for
-- the same pair that would land at any other revision is a contradiction the database can
-- refuse.
--
-- ## How a future strip re-opens the door
--
-- Deliberate, and the reason this is a trigger keyed on `topic_sources` rather than a
-- partial unique index on `topic_revisions (topic_id, document_id) where source = 'merge'`.
-- The index would be simpler and would also close the narrow crash window described in
-- route-and-merge.ts — but it could only ever be released by DELETING rows from
-- `topic_revisions`, which this schema declares immutable history (see its update/delete
-- policies, both `using (false)`). PLAN §5's strip already says it "deletes topic_sources
-- rows"; keying the trigger there means the strip's own documented action releases the
-- guard, with no concession on the immutability of history.
--
-- Safe to apply as written: documents, topics, topic_sources and topic_revisions all hold
-- ZERO rows on this project (verified before writing), so the NOT NULL column needs no
-- default and there is nothing for the trigger to reject retroactively.

/* ========================================================================== */
/* 1. topic_sources learns which revision the merge produced                  */
/* ========================================================================== */

-- No default, deliberately. A writer that does not know which revision its merge landed at
-- has no business writing provenance for it, and a default would let exactly that through.
alter table public.topic_sources
  add column merged_at_revision int not null check (merged_at_revision >= 1);

comment on column public.topic_sources.merged_at_revision is
  'The topics.revision value this document''s merge left the topic at. Together with the row''s own unique (topic_id, document_id) this is the merge idempotency key: its presence means "already merged", and its value says where a strip would have to replay from. Enforced by topic_revisions_one_merge_per_document.';

/* ========================================================================== */
/* 2. One merge revision per (topic, document)                                */
/* ========================================================================== */

-- `security invoker` (the default) on purpose: the function only reads public.topic_sources
-- rows for the same topic the caller is already writing a revision for, so it needs no
-- privilege the caller does not have. Under the service key RLS is not in the path at all;
-- under `authenticated` the select is RLS-filtered to the caller's own rows, which is the
-- same tenant by construction. Nothing here justifies `security definer`.
create function public.reject_duplicate_merge_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  recorded int;
begin
  -- Only merge revisions are constrained. A 'deep_review' or 'revert' row is a different
  -- event with its own lifecycle and may legitimately follow a merge on the same topic.
  if new.source <> 'merge' or new.document_id is null then
    return new;
  end if;

  select ts.merged_at_revision
    into recorded
    from public.topic_sources ts
   where ts.topic_id = new.topic_id
     and ts.document_id = new.document_id;

  -- No provenance row yet: this is the document's first merge into this topic. Allowed.
  if not found then
    return new;
  end if;

  -- A snapshot row records the page BEFORE the merge, so the merge that wrote it left the
  -- topic at `revision + 1`. Re-running the SAME persist re-derives the same value and is a
  -- genuine no-op — `unique (topic_id, revision)` catches the duplicate insert itself.
  -- Anything else is a second, DIFFERENT merge of a document that is already merged in.
  if recorded = new.revision + 1 then
    return new;
  end if;

  raise exception
    'document % is already merged into topic % at revision %; a merge snapshot at revision % would be a second contribution from the same document',
    new.document_id, new.topic_id, recorded, new.revision
    using
      -- Deliberately NOT 23505. route-and-merge.ts swallows 23505 on this insert (that is
      -- how it tolerates a re-run of an identical persist), so borrowing unique_violation
      -- here would make the guard silent and let the revision bump through anyway. P0001
      -- surfaces as a real error, fails that one topic, and leaves the rest of the document
      -- alone via the per-topic try in mergeTopics.
      errcode = 'P0001',
      hint = 'Strip the document''s prior contribution first (PLAN §5): replay the topic forward from its pre-merge snapshot and delete this topic_sources row. Until that strip exists, skip the topic instead.';
end;
$$;

comment on function public.reject_duplicate_merge_revision() is
  'BEFORE INSERT guard on topic_revisions: refuses a second source=''merge'' snapshot for a (topic_id, document_id) pair that topic_sources already records as merged. Released by deleting the topic_sources row, which is exactly what PLAN §5''s re-processing strip does.';

create trigger topic_revisions_one_merge_per_document
  before insert on public.topic_revisions
  for each row
  execute function public.reject_duplicate_merge_revision();

-- The trigger's lookup is (topic_id, document_id) — covered by topic_sources' own
-- unique (topic_id, document_id) index. No new index needed.
