-- Realtime for the upload status UI: publish documents and its progress feed.
--
-- Deferred from Wave 3 for a concrete reason rather than by oversight —
-- 20260719092113 records it: "Realtime publications are likewise out of scope.
-- There is nothing to publish until the tables exist, and a publication naming a
-- missing table does not apply." The tables landed in 20260719175553, so they
-- land here.
--
-- The subscriber (Wave 4 Agent 2) uses `postgres_changes` filtered by course_id,
-- which is why documents and document_processing_events both carry a course_id
-- column at all: postgres_changes filters on a column of the CHANGED ROW and
-- cannot join, so a filter by course is only possible if the row states its
-- course. The (document_id, course_id) FK on the events table keeps that
-- denormalised column honest.

/* ========================================================================== */
/* 1. Replica identity                                                        */
/* ========================================================================== */

-- REPLICA IDENTITY FULL, and this is the non-obvious half of making the
-- course_id filter usable.
--
-- The default replica identity is the primary key, which means a DELETE writes
-- ONLY the primary key into the WAL. Two things then break, and both break
-- silently — the events simply never arrive, with no error anywhere:
--
--   1. The course_id filter cannot match, because course_id is not in the
--      payload. A subscriber filtered on course_id sees no deletes at all.
--   2. Supabase Realtime's RLS check cannot pass either. It evaluates the
--      table's policies against the record it received, and every policy here is
--      `(select auth.uid()) = user_id` — with only the primary key present there
--      is no user_id to compare, so the row is withheld from every subscriber.
--
-- FULL puts the entire old row in the WAL, which fixes both. It also makes the
-- `old` record available on UPDATE, so a subscriber can tell which column
-- changed — useful for a status machine whose whole job is transitions.
--
-- The cost is WAL volume: every UPDATE and DELETE logs all columns rather than
-- the key. That is a real cost on a hot table, and it is being accepted
-- deliberately at this scale — a solo project uploading tens of documents a
-- week. Note `documents.extraction` is a potentially large jsonb column and is
-- rewritten mid-pipeline; if WAL volume ever becomes a problem, the fix is to
-- move `extraction` out to its own table rather than to give up the delete
-- events.
alter table public.documents replica identity full;
alter table public.document_processing_events replica identity full;

/* ========================================================================== */
/* 2. Publication                                                             */
/* ========================================================================== */

-- supabase_realtime already exists on this project with puballtables = false and
-- no member tables (verified 2026-07-19 before applying), so these are additions
-- to an empty publication rather than a redefinition of a populated one.
--
-- Realtime is NOT a security boundary being widened here: publishing a table
-- makes its changes available to the Realtime server, which then applies the
-- table's RLS policies per subscriber before forwarding anything. Both tables
-- had RLS enabled with four policies in 20260719175553, so a subscriber still
-- only ever receives its own rows. Publishing a table with RLS disabled would be
-- the mistake; that is not the case for either of these.
alter publication supabase_realtime add table public.documents;
alter publication supabase_realtime add table public.document_processing_events;
