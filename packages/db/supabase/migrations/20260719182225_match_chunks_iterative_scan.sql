-- match_chunks silently returns FEWER results than exist — often zero — as soon as
-- the planner chooses the HNSW index. Fixed by making the function ask pgvector to
-- iterate. (Wave 4 Gate 2, 2026-07-19.)
--
-- ## The defect
--
-- 20260719175555 built match_chunks as a filtered ANN query: an `order by embedding
-- <=> query limit k` with `where course_id = ...` in front of it, over a single HNSW
-- index that spans EVERY course and EVERY tenant.
--
-- That is the classic pgvector post-filter trap. An HNSW index scan does not know
-- about the course_id predicate. It walks the graph, produces `hnsw.ef_search`
-- candidates (default 40 on this project — verified), hands them up, and only THEN
-- does the executor drop the ones whose course_id does not match. If the 40 nearest
-- vectors in the whole table belong to other courses, the caller gets nothing back,
-- even though the requested course has plenty of embedded chunks.
--
-- It fails SILENTLY. No error, no warning — just an empty or short result set that
-- looks exactly like "this course has no relevant material". The three surfaces that
-- read through this function are course search, "ask your notes" (which would answer
-- from no context and cite nothing) and the exam-review generator (which would build
-- a review from a fraction of the syllabus). Wrong answers, confidently delivered.
--
-- ## Why it was not caught
--
-- It is latent at today's row counts and that is the whole problem. With seven empty
-- tables, or one small course, the planner prefers document_chunks_course_idx (btree)
-- and an exact sort, which has perfect recall — so every test passes. The switch to
-- the HNSW plan happens on cost, quietly, once the table grows. The bug ships green
-- and appears weeks later as "search got worse", with nothing in the logs.
--
-- Reproduced at gate on the live project, 3010 chunks (3000 in a decoy course, 10 in
-- the queried course), HNSW plan forced:
--
--   iterative_scan = off (pgvector default)  → match_chunks(..., 8) returned 0 of 10
--   iterative_scan = 'strict_order'          → match_chunks(..., 8) returned 8 of 10
--
-- ## The fix, and why it lives on the function
--
-- pgvector 0.8.0 added iterative index scans for exactly this case: the scan resumes
-- and fetches more candidates when the filter eats the batch, instead of giving up at
-- ef_search. This project runs pgvector 0.8.2, so it is available today.
--
-- It is attached as a FUNCTION-LEVEL SET rather than left to callers. Callers are
-- Inngest steps and route handlers across three future waves; a GUC they each have to
-- remember to set is a GUC that will be missing somewhere, and the failure mode is
-- silent. Postgres applies a function's SET clauses on entry and restores them on
-- exit, so the guarantee travels with the retrieval surface itself — which is the
-- reason PLAN §6 put every embedding read behind this one function in the first place.
--
-- `strict_order`, not `relaxed_order`. match_chunks documents its contract as
-- "ordered by descending similarity" and its callers take a top-k prefix and cite it;
-- relaxed_order is faster but may return rows slightly out of distance order, which
-- would quietly mis-rank citations. Ordering verified at gate: strict_order returned
-- the 8 rows monotonically non-increasing in similarity.
--
-- The body below is unchanged from 20260719175555 apart from the added SET. That
-- migration is not edited; this replaces the function.
--
-- ## Why the no-op vector expression below is load-bearing
--
-- `create function ... set hnsw.iterative_scan` fails with
-- "permission denied to set parameter" (SQLSTATE 42501) on a bare migration
-- connection, and the reason is not a missing grant. pgvector registers its GUCs
-- from its shared library, and Postgres only loads that library the first time a
-- session actually touches pgvector code. Until then `hnsw.iterative_scan` is an
-- unregistered placeholder, and CREATE FUNCTION refuses to store a SET for a
-- parameter it cannot validate — as `postgres` on Supabase is not a superuser.
--
-- Touching the `<=>` operator once loads the library, at which point the GUC is
-- registered as context `user` (verified: settable by a non-superuser) and the
-- CREATE below validates. Same session, so this must stay in this file, above the
-- function. Deleting it as "a pointless select" breaks the migration.
select '[1,2,3]'::extensions.vector OPERATOR(extensions.<=>) '[1,2,3]'::extensions.vector;

create or replace function public.match_chunks(
  p_course_id uuid,
  p_query_embedding extensions.vector(1024),
  p_match_count int default 8,
  p_source text default null,
  p_topic_id uuid default null
)
returns table (
  id uuid,
  document_id uuid,
  topic_id uuid,
  source text,
  content text,
  locator jsonb,
  similarity real
)
language sql
stable
security invoker
set search_path = ''
-- The fix. See the header: without this, a course filter over a shared HNSW index
-- post-filters an ef_search-sized batch and can return zero rows for a course that
-- has hundreds.
set hnsw.iterative_scan = 'strict_order'
as $$
  select
    c.id,
    c.document_id,
    c.topic_id,
    c.source,
    c.content,
    c.locator,
    (1 - (c.embedding OPERATOR(extensions.<=>) p_query_embedding))::real as similarity
  from public.document_chunks c
  where c.course_id = p_course_id
    and c.embedding is not null
    and (p_source is null or c.source = p_source)
    and (p_topic_id is null or c.topic_id = p_topic_id)
  order by c.embedding OPERATOR(extensions.<=>) p_query_embedding
  limit least(greatest(p_match_count, 1), 200)
$$;

comment on function public.match_chunks is
  'Cosine ANN retrieval over document_chunks for one course, ordered by descending similarity. security invoker: RLS on document_chunks does the tenant filtering, so there is no user_id argument and no user_id predicate in the body. p_source / p_topic_id are optional narrowing filters; p_match_count is clamped to 1..200. Sets hnsw.iterative_scan = strict_order so the course_id filter cannot silently truncate the ANN result to zero — see 20260719182225.';
