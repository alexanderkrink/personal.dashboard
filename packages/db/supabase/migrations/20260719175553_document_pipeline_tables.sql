-- The document pipeline's spine: documents, its progress feed, the cumulative
-- topic knowledge base, provenance, RAG chunks, and the per-course exam review.
-- (PLAN "Document & Notes Pipeline" §2; M1 item 5a.)
--
-- ORDERING IS LOAD-BEARING, for the same reason it was in 20260718174222
-- (calendar_tables). Every foreign key below that crosses two user-owned tables
-- is composite `(fk_column, user_id)` against an `(id, user_id)` unique key on
-- the parent — RLS-strategy rule 7. A composite FK cannot be declared before its
-- parent's matching unique key exists, so the tables are created in dependency
-- order and each parent declares its own keys inline, before any child points at
-- it:
--
--   courses.(id, user_id)      -- 20260718140050
--   documents.(id, user_id)    -- HERE, before document_processing_events/topic_*/document_chunks
--   topics.(id, user_id)       -- HERE, before topic_revisions/topic_sources/document_chunks
--
-- ⚠ DEVIATION FROM PLAN §2, and the largest one in this file. The SQL block in
-- PLAN §2 was written before Wave 1 found the cross-tenant FK hole, and it still
-- spells every foreign key single-column (`references courses(id)`). That form
-- is exactly what RLS-strategy rule 7 forbids: RLS validates the row being
-- WRITTEN, never the row being POINTED AT, and this pipeline's writers are
-- Inngest jobs running under createAdminSupabaseClient, where RLS is not in the
-- path at all. Every FK in this file is therefore widened to
-- (fk_column, user_id). PLAN §2 is marked with a dated ⚠ CORRECTED note rather
-- than rewritten.
--
-- Safe to apply as written: all seven tables are new, so there is no backfill
-- and nothing to reject. The only pre-existing object touched is courses, and
-- only as the read-only target of its existing (id, user_id) key.

/* ========================================================================== */
/* 0. The pipeline state machine                                              */
/* ========================================================================== */

-- A real Postgres enum, and the only one in the schema. The data-model
-- convention is "enums as text + check constraints (cheap to evolve)" — it
-- carves out one exception, "high-churn pipeline states where a Postgres enum
-- documents the state machine (document_status)", and this is it. The values are
-- consumed by the status UI and by the job's step transitions, so having the
-- database refuse an unknown one is worth the costlier ALTER TYPE.
create type public.document_status as enum (
  'queued',
  'validating',
  'extracting',
  'structuring',
  'merging',
  'embedding',
  'ready',
  'partial',
  'failed'
);

comment on type public.document_status is
  'Pipeline state for a documents row. Terminal states: ready, partial, failed.';

/* ========================================================================== */
/* 1. documents — the mutable state machine                                   */
/* ========================================================================== */

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid not null,
  kind text not null check (kind in ('slides', 'reading', 'case', 'syllabus', 'other')),

  -- {user_id}/{course_id}/{document_id}/{filename}. The check constraint below
  -- turns that comment into an invariant — see documents_storage_path_convention.
  storage_path text not null,
  filename text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0),

  -- sha256 of the file bytes; dedupe + idempotency key for the whole pipeline.
  content_hash text not null,

  status public.document_status not null default 'queued',

  -- User-readable, set on failed/partial. Never a stack trace and never a signed
  -- URL: the client reads this column back.
  failure_reason text,

  -- Structured extraction output: per-page/slide/chapter markdown plus declared
  -- 'skipped' ranges.
  extraction jsonb,

  -- Set explicitly by `extract`, never defaulted: native PDF = 'visual', PPTX XML
  -- path = 'text-only', PPTX→PDF conversion = 'visual' (§4.1/§4.2). Drives the
  -- UI's quality note, so a default would silently misreport fidelity.
  extraction_fidelity text check (extraction_fidelity in ('text-only', 'visual')),

  -- [{topicKey, error}] set by finalize on 'partial'; the retry set for
  -- document/retry-merges (§7).
  failed_topics jsonb not null default '[]',

  -- {pagesTotal, pagesMapped, unmapped:[{from,to,reason}],
  --  syllabusChecklist:[{objective, covered, topic_id?}]} (§5, §8).
  coverage jsonb,

  -- Opt-in second-reader completeness audit (§5 Step D).
  deep_review text not null default 'off'
    check (deep_review in ('off', 'requested', 'running', 'done')),
  deep_reviewed_at timestamptz,

  -- e.g. "Lecture 7" — user-supplied or inferred.
  session_label text,

  created_at timestamptz not null default now(),
  -- documents is the pipeline's MUTABLE STATE MACHINE, so it is one of the two
  -- tables in this file that carries updated_at (topics is the other). The five
  -- append-only / immutable-history / provenance tables below deliberately do
  -- not — the data-model Conventions list names them individually.
  updated_at timestamptz not null default now(),
  processed_at timestamptz,

  -- Parent lookup key for the (document_id, user_id) FKs on
  -- document_processing_events, topic_revisions, topic_sources and
  -- document_chunks. Strictly redundant with the primary key, but a foreign key
  -- must target a unique constraint covering exactly its referenced columns.
  constraint documents_id_user_key unique (id, user_id),

  -- Second parent key, and NOT redundant with the one above. It scopes children
  -- to the same COURSE, not merely the same tenant. Without it a chunk or a
  -- progress event could carry a course_id belonging to a different course of
  -- the same user — same tenant, so rule 7's key resolves fine — and the result
  -- is a chunk that surfaces in the wrong course's search results, or a Realtime
  -- event delivered to the wrong course's subscriber. Cheap here, impossible to
  -- reconstruct once bad rows exist.
  constraint documents_id_course_key unique (id, course_id),

  -- Ties the row to the bytes it claims. The storage policies (20260719092113)
  -- enforce that the FIRST path segment is the uploader's uid, which stops user
  -- B writing under user A's prefix; they cannot check segments 2 and 3, because
  -- storage.objects knows nothing about courses or documents. This check closes
  -- the other half: a documents row cannot point at a path belonging to a
  -- different course or a different document id. Together the two make the path
  -- convention an invariant rather than a comment.
  constraint documents_storage_path_convention check (
    storage_path like (user_id::text || '/' || course_id::text || '/' || id::text || '/%')
  ),

  -- Tenant-scoped (rule 7). ON DELETE CASCADE: deleting a course deletes its
  -- documents, unchanged in spirit from PLAN §2's single-column form.
  constraint documents_course_id_fkey foreign key (course_id, user_id)
    references public.courses (id, user_id) on delete cascade
);

comment on table public.documents is
  'One uploaded source file per row, and the pipeline state machine that processes it. Mutable: status, coverage, extraction and failure_reason are all rewritten as the job progresses.';

comment on column public.documents.content_hash is
  'sha256 of the file bytes. Dedupe key (documents_dedupe) and the pipeline''s idempotency key: re-uploading identical bytes to the same course is rejected rather than re-billed.';

comment on column public.documents.storage_path is
  '{user_id}/{course_id}/{document_id}/{filename}, enforced by documents_storage_path_convention. Storage RLS independently enforces the first segment.';

comment on column public.documents.extraction_fidelity is
  'text-only | visual. Set explicitly by the extract step, never defaulted — it drives the UI''s quality note, so a default would misreport fidelity.';

-- PLAN §2: `create unique index documents_dedupe on documents (course_id, content_hash)`.
-- Kept verbatim. Same bytes, same course = the same document; the pipeline is
-- expensive enough that a duplicate upload must fail fast rather than re-run.
create unique index documents_dedupe
  on public.documents (course_id, content_hash);

-- Status board / Realtime backfill: "the documents of this course, newest first".
create index documents_course_status_idx
  on public.documents (user_id, course_id, created_at desc);

alter table public.documents enable row level security;

create policy "Users can view own documents"
  on public.documents for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert own documents"
  on public.documents for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update own documents"
  on public.documents for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete own documents"
  on public.documents for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create trigger documents_set_updated_at
  before update on public.documents
  for each row
  execute function public.set_updated_at();

/* ========================================================================== */
/* 2. document_processing_events — append-only progress feed                  */
/* ========================================================================== */

create table public.document_processing_events (
  -- bigint identity, per PLAN §2: a high-volume append-only log where a
  -- monotonic id doubles as the feed's ordering key, which uuid v4 would not.
  --
  -- NOTE for deriveOwner() (apps/web/src/inngest/owner.ts): its locator takes
  -- `id: string`, and PostgREST renders bigint as a JSON number. This table is
  -- therefore NOT usable as a deriveOwner source — which is correct rather than
  -- a limitation: jobs derive ownership from `documents`, the row the event
  -- points at. Nothing should ever ask "who owns this log line".
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  document_id uuid not null,
  -- Denormalised from documents so Realtime can filter on it — postgres_changes
  -- filters on a column of the changed row and cannot join. Kept honest by the
  -- (document_id, course_id) FK below.
  course_id uuid not null,

  -- 'extract', 'merge:topic:<id>', ... Free-form on purpose: the step vocabulary
  -- changes with the pipeline, and a check constraint here would turn every new
  -- step into a migration.
  step text not null,
  level text not null default 'info' check (level in ('info', 'warn', 'error')),
  detail text,
  created_at timestamptz not null default now(),

  -- No updated_at: append-only log, named as such in the data-model Conventions.

  constraint document_processing_events_document_id_fkey
    foreign key (document_id, user_id)
    references public.documents (id, user_id) on delete cascade,

  -- Course consistency, not tenancy: guarantees the Realtime filter column
  -- actually names the course the document belongs to.
  constraint document_processing_events_course_id_fkey
    foreign key (document_id, course_id)
    references public.documents (id, course_id) on delete cascade
);

comment on table public.document_processing_events is
  'Append-only fine-grained progress feed for the status UI, published to Realtime. Never updated after insert, hence no updated_at.';

comment on column public.document_processing_events.course_id is
  'Denormalised from documents purely so postgres_changes can filter on it. Held consistent by document_processing_events_course_id_fkey.';

-- The feed query: this document's events in order.
create index document_processing_events_document_idx
  on public.document_processing_events (document_id, id);

-- Backs the Realtime course filter and the (document_id, course_id) FK.
create index document_processing_events_course_idx
  on public.document_processing_events (course_id, id desc);

alter table public.document_processing_events enable row level security;

create policy "Users can view own processing events"
  on public.document_processing_events for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert own processing events"
  on public.document_processing_events for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

-- ⚠ DEVIATION, deliberate, and consistent with 20260719120203 (which dropped the
-- user-facing DELETE policy on ai_generations for the same reason). An
-- append-only audit feed that the audited party can rewrite is not an audit
-- feed. Both policies exist so the table carries the conventional four, and both
-- refuse: `using (false)` is unsatisfiable for every row and every caller, so
-- the grant is present, enumerable, and inert. Inngest writes through the admin
-- client and is unaffected; cleanup happens by cascade when the document goes.
create policy "Processing events are never updated"
  on public.document_processing_events for update
  to authenticated
  using (false)
  with check (false);

create policy "Processing events are never deleted"
  on public.document_processing_events for delete
  to authenticated
  using (false);

/* ========================================================================== */
/* 3. topics — the cumulative knowledge base                                  */
/* ========================================================================== */

create table public.topics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid not null,
  title text not null,
  slug text not null,
  summary text not null default '',

  -- TopicPage: notes blocks, key terms, formulas, worked examples, open
  -- questions. Zod schema in packages/ai/src/schemas/.
  page jsonb not null default '{}',

  -- extensions.vector, not a bare `vector`: 20260719092113 installed pgvector
  -- into `extensions` rather than `public` to avoid Supabase's
  -- extension_in_public advisory, so the type has to be spelled out. Same reason
  -- the HNSW index below names extensions.vector_cosine_ops and match_chunks
  -- writes OPERATOR(extensions.<=>).
  title_embedding extensions.vector(1024),
  summary_embedding extensions.vector(1024),

  -- Computed 0..1; the user's override wins when set.
  exam_weight real not null default 0.5 check (exam_weight >= 0 and exam_weight <= 1),
  exam_weight_override real check (exam_weight_override >= 0 and exam_weight_override <= 1),

  revision int not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  -- Rewritten by every merge, so it carries updated_at (PLAN §2 gives it one).
  updated_at timestamptz not null default now(),

  unique (course_id, slug),

  constraint topics_id_user_key unique (id, user_id),
  constraint topics_id_course_key unique (id, course_id),

  constraint topics_course_id_fkey foreign key (course_id, user_id)
    references public.courses (id, user_id) on delete cascade
);

comment on table public.topics is
  'The cumulative per-course knowledge base. A new upload rewrites existing topic pages in place (revision bumps, prior page snapshotted into topic_revisions) rather than adding a per-lecture silo.';

comment on column public.topics.exam_weight_override is
  'User override, 0..1. Non-null wins over the computed exam_weight — the user is allowed to be right about their own exam.';

alter table public.topics enable row level security;

create policy "Users can view own topics"
  on public.topics for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert own topics"
  on public.topics for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update own topics"
  on public.topics for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete own topics"
  on public.topics for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create trigger topics_set_updated_at
  before update on public.topics
  for each row
  execute function public.set_updated_at();

/* ========================================================================== */
/* 4. topic_revisions — immutable history                                     */
/* ========================================================================== */

create table public.topic_revisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  topic_id uuid not null,
  revision int not null check (revision >= 1),

  -- Full TopicPage snapshot BEFORE this merge applied — that is what makes a
  -- revert a copy rather than a reconstruction.
  page jsonb not null,
  change_summary text not null,
  source text not null default 'merge'
    check (source in ('merge', 'deep_review', 'revert')),

  -- True when the merge critic still flagged the result after one auto-retry
  -- (§5 Step B2). The UI surfaces these for human review.
  needs_review boolean not null default false,

  -- Which upload caused it. Nullable, and SET NULL (not cascade) on document
  -- delete: the revision is history and must outlive the document that produced
  -- it, or deleting an upload would silently rewrite the audit trail.
  document_id uuid,

  -- AI strategy §3 five-column stamp.
  prompt_id text not null,
  prompt_version int not null,
  provider text not null check (provider in ('anthropic', 'google')),
  model text not null,
  input_hash text not null,

  created_at timestamptz not null default now(),
  -- No updated_at: immutable history, named as such in the data-model Conventions.

  unique (topic_id, revision),

  constraint topic_revisions_topic_id_fkey foreign key (topic_id, user_id)
    references public.topics (id, user_id) on delete cascade,

  -- The column-list form of ON DELETE SET NULL, per the 20260718140050 exemplar
  -- and RLS-strategy rule 7: the bare form would try to null every referencing
  -- column including user_id, which is NOT NULL, so deleting a document would
  -- fail outright. Naming document_id nulls only that column. PostgreSQL 15+;
  -- this project runs 17.6.
  --
  -- document_id stays nullable and the FK keeps MATCH SIMPLE, so a revision with
  -- no originating document (a revert, or a post-delete row) skips the check.
  constraint topic_revisions_document_id_fkey foreign key (document_id, user_id)
    references public.documents (id, user_id) on delete set null (document_id)
);

comment on table public.topic_revisions is
  'Immutable revision history: one row per merge, deep-review edit or revert, holding the topic page as it was BEFORE that change. Never updated after insert, hence no updated_at.';

comment on constraint topic_revisions_document_id_fkey on public.topic_revisions is
  'ON DELETE SET NULL (document_id) — column-list form. Deleting an upload must not erase the history it produced.';

create index topic_revisions_document_idx
  on public.topic_revisions (document_id);

alter table public.topic_revisions enable row level security;

create policy "Users can view own topic revisions"
  on public.topic_revisions for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert own topic revisions"
  on public.topic_revisions for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

-- Same reasoning as document_processing_events: history that can be edited is
-- not history. The revert path WRITES A NEW ROW (source = 'revert'); it never
-- rewrites an old one.
create policy "Topic revisions are never updated"
  on public.topic_revisions for update
  to authenticated
  using (false)
  with check (false);

create policy "Topic revisions are never deleted"
  on public.topic_revisions for delete
  to authenticated
  using (false);

/* ========================================================================== */
/* 5. topic_sources — coarse provenance join                                  */
/* ========================================================================== */

create table public.topic_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  topic_id uuid not null,
  document_id uuid not null,

  -- [{page:12},{slide:4}] — where in the document this topic was fed from.
  locators jsonb not null default '[]',
  created_at timestamptz not null default now(),
  -- No updated_at: provenance join table, named as such in the Conventions.
  -- `locators` is rewritten by re-processing, but the row is identified by
  -- (topic_id, document_id) and carries no independent lifecycle worth stamping.

  unique (topic_id, document_id),

  constraint topic_sources_topic_id_fkey foreign key (topic_id, user_id)
    references public.topics (id, user_id) on delete cascade,

  constraint topic_sources_document_id_fkey foreign key (document_id, user_id)
    references public.documents (id, user_id) on delete cascade
);

comment on table public.topic_sources is
  'Coarse provenance: which document fed which topic, and where. The fine-grained provenance is block-level `sources` inside topics.page. Also the idempotency key for re-processing (§7).';

create index topic_sources_document_idx
  on public.topic_sources (document_id);

alter table public.topic_sources enable row level security;

create policy "Users can view own topic sources"
  on public.topic_sources for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert own topic sources"
  on public.topic_sources for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update own topic sources"
  on public.topic_sources for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete own topic sources"
  on public.topic_sources for delete
  to authenticated
  using ((select auth.uid()) = user_id);

/* ========================================================================== */
/* 6. document_chunks — RAG                                                   */
/* ========================================================================== */

create table public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid not null,

  -- Null for synthesized chunks (topic-page sections embedded so search covers
  -- the notes, not just the raw sources — §6). Exactly one of document_id /
  -- topic_id is the owner, per `source`; document_chunks_owner enforces it.
  document_id uuid,
  topic_id uuid,

  source text not null default 'document'
    check (source in ('document', 'topic_page')),
  content text not null,

  -- sha256(normalized content) — the embedding-reuse key. Re-uploading a deck
  -- with one changed slide re-embeds one chunk, not the whole deck.
  chunk_hash text not null,
  token_count int not null check (token_count > 0),

  -- {page} | {slide} for source='document'; {topicId, section} for
  -- source='topic_page'.
  locator jsonb not null,

  -- Voyage voyage-3.5-lite, 1024 dims (§6). Nullable: the row is written by the
  -- chunk step and filled by the embed step, which are separate Inngest steps
  -- with independent retry budgets.
  embedding extensions.vector(1024),

  created_at timestamptz not null default now(),
  -- No updated_at: join/provenance table, named as such in the Conventions.

  -- PLAN §2's constraint, kept verbatim. This is the file's model for
  -- "structural invariants belong in the database": the source discriminator and
  -- the two nullable owner columns can disagree, and the only writer is a
  -- service-role job that RLS never sees.
  constraint document_chunks_owner check (
    (source = 'document' and document_id is not null) or
    (source = 'topic_page' and topic_id is not null)
  ),

  constraint document_chunks_course_id_fkey foreign key (course_id, user_id)
    references public.courses (id, user_id) on delete cascade,

  constraint document_chunks_document_id_fkey foreign key (document_id, user_id)
    references public.documents (id, user_id) on delete cascade,

  -- Course consistency: a chunk cannot claim a course its document does not
  -- belong to. Without this a same-tenant, wrong-course chunk would pass rule
  -- 7's tenant check and then surface in the wrong course's search results,
  -- because match_chunks filters on course_id.
  constraint document_chunks_document_course_fkey foreign key (document_id, course_id)
    references public.documents (id, course_id) on delete cascade,

  -- Column-list SET NULL again: topic_id is filled after routing and cleared if
  -- the topic is later deleted, but the chunk itself survives — its text and
  -- embedding are still valid course material.
  constraint document_chunks_topic_id_fkey foreign key (topic_id, user_id)
    references public.topics (id, user_id) on delete set null (topic_id),

  constraint document_chunks_topic_course_fkey foreign key (topic_id, course_id)
    references public.topics (id, course_id) on delete set null (topic_id)
);

comment on table public.document_chunks is
  'RAG chunks over both raw documents (source=''document'') and synthesized topic pages (source=''topic_page''), embedded with Voyage voyage-3.5-lite at 1024 dims. Retrieved through public.match_chunks().';

comment on column public.document_chunks.chunk_hash is
  'sha256 of the normalized content. Embedding-reuse key: an unchanged chunk_hash means the stored embedding can be carried over instead of re-billed.';

-- §6: HNSW over IVFFlat because IVFFlat needs representative data at build time
-- and re-training as the table grows from zero — exactly our situation — while
-- HNSW builds incrementally. Cosine to match Voyage's normalized vectors.
-- vector(1024) is well inside HNSW's 2000-dim ceiling, so no halfvec yet.
create index document_chunks_embedding_idx
  on public.document_chunks
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- Every query filters course_id before the ANN scan (§6).
create index document_chunks_course_idx
  on public.document_chunks (course_id);

-- Embedding reuse lookup.
create index document_chunks_hash_idx
  on public.document_chunks (user_id, chunk_hash);

-- FK cascade support, and "the chunks of this document" for re-processing.
create index document_chunks_document_idx
  on public.document_chunks (document_id);

create index document_chunks_topic_idx
  on public.document_chunks (topic_id);

-- 🔴 PLAN §2 IS INTERNALLY INCONSISTENT HERE, disproved 2026-07-19 (Wave 4
--    Agent 1). §2 gives `topic_id ... on delete set null` AND an owner check
--    requiring `source = 'topic_page' → topic_id is not null`. The two cannot
--    both hold: deleting a topic that has synthesized topic_page chunks nulls
--    their topic_id, which immediately violates document_chunks_owner, and the
--    DELETE fails. As written, a topic with synthesized chunks is undeletable.
--
--    Neither constraint is wrong on its own; the missing piece is that the two
--    chunk sources have different lifecycles against a topic:
--      - source='document'   → topic_id is a ROUTING LABEL. The chunk is raw
--                              source text and stays valid when the topic goes;
--                              nulling it is exactly right.
--      - source='topic_page' → topic_id is the OWNER. The chunk is a slice of
--                              the topic page itself, so once the topic is gone
--                              the chunk is orphaned text that would keep
--                              answering searches from a page that no longer
--                              exists.
--
--    A single FK cannot branch on a column, so the owning case is handled one
--    step earlier, in the database rather than in whichever caller happens to
--    delete a topic. BEFORE DELETE row triggers run before the FK's referential
--    action, so by the time SET NULL fires there are no topic_page rows left for
--    it to invalidate.
create function public.delete_synthesized_chunks_for_topic()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Only the synthesized slices of THIS topic page. source='document' chunks are
  -- deliberately left for the FK's SET NULL (topic_id) to unlabel.
  delete from public.document_chunks
  where topic_id = old.id
    and source = 'topic_page';
  return old;
end;
$$;

comment on function public.delete_synthesized_chunks_for_topic is
  'BEFORE DELETE on topics: removes the topic''s own synthesized (source=''topic_page'') chunks so the FK''s SET NULL (topic_id) cannot strand them in violation of document_chunks_owner. security invoker — a session caller deletes only rows its own RLS policies expose.';

create trigger topics_delete_synthesized_chunks
  before delete on public.topics
  for each row
  execute function public.delete_synthesized_chunks_for_topic();

alter table public.document_chunks enable row level security;

create policy "Users can view own document chunks"
  on public.document_chunks for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert own document chunks"
  on public.document_chunks for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update own document chunks"
  on public.document_chunks for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete own document chunks"
  on public.document_chunks for delete
  to authenticated
  using ((select auth.uid()) = user_id);

/* ========================================================================== */
/* 7. exam_reviews                                                            */
/* ========================================================================== */

create table public.exam_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid not null,

  -- ExamReview: weighted sections, formula sheet, question bank.
  content jsonb not null,

  -- [{topic_id, revision}] it was built from. The snapshot says WHAT the review
  -- was built from; `stale` says WHETHER it has since drifted.
  topic_snapshot jsonb not null,
  stale boolean not null default false,

  -- AI strategy §3 five-column stamp.
  prompt_id text not null,
  prompt_version int not null,
  provider text not null check (provider in ('anthropic', 'google')),
  model text not null,
  input_hash text not null,

  created_at timestamptz not null default now(),
  -- No updated_at, per the Conventions list, which names exam_reviews among the
  -- immutable-history tables. The one mutable column is `stale`, a derived flag
  -- flipped by the topics.changed consumer — regeneration writes a NEW row
  -- rather than editing this one, so there is no content history to stamp.

  constraint exam_reviews_course_id_fkey foreign key (course_id, user_id)
    references public.courses (id, user_id) on delete cascade
);

comment on table public.exam_reviews is
  'Generated final-exam review per course. Append-only history: regeneration inserts a new row and the newest non-stale row wins. `stale` is flipped in place by the topics.changed consumer.';

-- "The current review for this course" — the only read this table has.
create index exam_reviews_course_idx
  on public.exam_reviews (user_id, course_id, created_at desc);

alter table public.exam_reviews enable row level security;

create policy "Users can view own exam reviews"
  on public.exam_reviews for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert own exam reviews"
  on public.exam_reviews for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update own exam reviews"
  on public.exam_reviews for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete own exam reviews"
  on public.exam_reviews for delete
  to authenticated
  using ((select auth.uid()) = user_id);
