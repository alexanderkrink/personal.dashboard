-- Covering indexes for the document pipeline's composite foreign keys.
--
-- Same follow-up 20260718174739 did for the calendar tables, and for the same
-- reason: tenant-scoped FKs are two columns wide, so a single-column index on
-- the referencing column does not cover them. Postgres can still use a narrower
-- index for the cascade scan, but the planner prefers an exact match and
-- Supabase's `unindexed_foreign_keys` linter flags anything else. 20260719175553
-- created the narrow ones; this widens them to the FK column lists exactly.
--
-- Applied against empty tables (all seven were created minutes earlier and hold
-- 0 rows, verified), so every index below builds instantly and no lock matters.
--
-- ## What is deliberately NOT indexed: the bare user_id FKs
--
-- The linter also flags `<table>_user_id_fkey` on document_processing_events,
-- topic_revisions, topic_sources and topics — the FK to auth.users. Those are
-- left uncovered on purpose. That FK's cascade fires exactly once in a row's
-- lifetime, when the ACCOUNT ITSELF is deleted, which is a once-ever operation
-- for a solo project and is allowed to take a sequential scan. Every query the
-- app actually runs filters user_id together with something more selective, and
-- those composites are indexed below. An index per table to speed up account
-- deletion would be paid for on every insert forever.

/* ── documents ─────────────────────────────────────────────────────────── */

-- Widens documents_course_status_idx's role: the FK is (course_id, user_id),
-- and documents_dedupe (course_id, content_hash) only shares its leading column.
create index documents_course_user_idx
  on public.documents (course_id, user_id);

/* ── document_processing_events ────────────────────────────────────────── */

drop index public.document_processing_events_document_idx;

create index document_processing_events_document_idx
  on public.document_processing_events (document_id, user_id);

-- Course-consistency FK, and the Realtime course filter's backing index.
drop index public.document_processing_events_course_idx;

create index document_processing_events_course_idx
  on public.document_processing_events (document_id, course_id);

-- Kept separately because the feed UI reads "this course's events, newest
-- first" without knowing a document id — the FK index above cannot serve that.
create index document_processing_events_course_feed_idx
  on public.document_processing_events (course_id, id desc);

/* ── topics ────────────────────────────────────────────────────────────── */

create index topics_course_user_idx
  on public.topics (course_id, user_id);

/* ── topic_revisions ───────────────────────────────────────────────────── */

create index topic_revisions_topic_user_idx
  on public.topic_revisions (topic_id, user_id);

drop index public.topic_revisions_document_idx;

create index topic_revisions_document_idx
  on public.topic_revisions (document_id, user_id);

/* ── topic_sources ─────────────────────────────────────────────────────── */

create index topic_sources_topic_user_idx
  on public.topic_sources (topic_id, user_id);

drop index public.topic_sources_document_idx;

create index topic_sources_document_idx
  on public.topic_sources (document_id, user_id);

/* ── document_chunks ───────────────────────────────────────────────────── */

-- The write-heaviest table in the pipeline, so this is the one place the
-- trade-off is worth stating: five FK indexes is a real per-insert cost, and it
-- is accepted because every one of them also backs a cascade path that can
-- delete tens of thousands of rows (dropping a course, a document, or a topic).
-- document_chunks_hash_idx (user_id, chunk_hash) and the HNSW embedding index
-- from 20260719175553 are untouched.
drop index public.document_chunks_course_idx;

create index document_chunks_course_idx
  on public.document_chunks (course_id, user_id);

drop index public.document_chunks_document_idx;

create index document_chunks_document_idx
  on public.document_chunks (document_id, user_id);

create index document_chunks_document_course_idx
  on public.document_chunks (document_id, course_id);

drop index public.document_chunks_topic_idx;

create index document_chunks_topic_idx
  on public.document_chunks (topic_id, user_id);

create index document_chunks_topic_course_idx
  on public.document_chunks (topic_id, course_id);

/* ── exam_reviews ──────────────────────────────────────────────────────── */

create index exam_reviews_course_user_idx
  on public.exam_reviews (course_id, user_id);
