-- match_chunks returns another tenant's chunks when called through the admin client.
-- Fixed by making the tenant a required argument and a predicate. (Wave 5, 2026-07-20.)
--
-- ## The defect
--
-- 20260719175555 built match_chunks as `security invoker` and justified the absence of a
-- user_id predicate in its own comment:
--
--   "security invoker: RLS on document_chunks does the tenant filtering, so there is no
--    user_id argument and no user_id predicate in the body."
--
-- That reasoning is sound for exactly one of the two clients this codebase uses. Under
-- `createClient()` the caller is `authenticated`, RLS applies, and the claim holds. Under
-- `createAdminSupabaseClient` the caller is `service_role`, which BYPASSES RLS — and then
-- the only surviving filter is `course_id = p_course_id`. A course id is not a secret and
-- is not self-authenticating: any caller that takes a course id from a request and passes
-- it to this function through the admin client reads whatever tenant owns that course.
--
-- The whole retrieval surface is designed to run in Inngest steps and background jobs,
-- which is precisely where the admin client lives. So the safe caller is the exception and
-- the dangerous one is the design centre.
--
-- ## Reproduced on the live project, 2026-07-20, BEFORE this migration
--
-- Second tenant recreated (hans.tabrizian@gmail.com, c0717646-…), seeded with one course
-- and one embedded chunk. As service_role — the admin client — asking for HANS's course
-- while acting for ALEXANDER (0092dd81-…):
--
--   POST /rest/v1/rpc/match_chunks
--     { p_course_id: <hans course>, p_query_embedding: [...], p_match_count: 8 }
--
--   -> 200, 1 row
--      "HANS PRIVATE CHUNK - if another tenant can read this, match_chunks leaks."
--
-- There was no user_id anywhere in that call for the function to check against, which is
-- the bug: the function had no way to express "and this must belong to the user I am
-- acting for", so no caller could have used it safely even if it wanted to.
--
-- ## The fix
--
-- `p_user_id uuid` becomes the FIRST and REQUIRED parameter, and `c.user_id = p_user_id`
-- becomes a predicate. Two consequences, both deliberate:
--
-- 1. Required, not defaulted. A caller that forgets the tenant now fails loudly — PostgREST
--    answers PGRST202 "function not found" rather than quietly returning a full course.
--    Silent wrong answers are the failure mode this file already exists to prevent; a
--    defaulted `p_user_id` would have reintroduced it.
-- 2. The old signature is DROPPED, not replaced. `create or replace` cannot change a
--    parameter list, so it would have left the 5-argument vulnerable overload resolvable
--    alongside the new one and fixed nothing. There are no callers today — `route-and-merge`
--    only mentions the name in a comment — so this is the cheapest moment it will ever be.
--
-- Belt and braces: when `auth.uid()` is non-null the caller is a real session, and it must
-- match `p_user_id`. RLS already stops that caller from reading across tenants, so this is
-- redundant by design — it exists so the function is correct on its own terms rather than
-- correct only because something else is.
--
-- ## Why this does not reintroduce the post-filter trap
--
-- 20260719182225 found that a `course_id` filter over the shared HNSW index post-filters an
-- ef_search-sized batch and can silently return zero rows, and fixed it with a
-- function-level `set hnsw.iterative_scan = 'strict_order'`. Adding `user_id` adds a SECOND
-- predicate the index scan does not know about, which makes that setting more load-bearing,
-- not less. It is carried over verbatim below. `document_chunks_course_idx` is already
-- `(course_id, user_id)`, so the btree plan covers the new predicate with no new index.
--
-- The body is otherwise unchanged from 20260719182225. Neither prior migration is edited.
--
-- The no-op vector expression below is load-bearing for the same reason it was there
-- before: pgvector registers `hnsw.iterative_scan` only once its shared library is loaded,
-- and until then `create function ... set hnsw.iterative_scan` fails with 42501
-- "permission denied to set parameter". Touching the `<=>` operator once loads it. Same
-- session, so it must stay in this file, above the function.
select '[1,2,3]'::extensions.vector OPERATOR(extensions.<=>) '[1,2,3]'::extensions.vector;

-- Drop the vulnerable overload. Argument types only — this is the 20260719182225 signature.
drop function if exists public.match_chunks(uuid, extensions.vector, int, text, uuid);

create or replace function public.match_chunks(
  p_user_id uuid,
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
-- See 20260719182225. Without this, the course_id + user_id filters post-filter an
-- ef_search-sized batch and can return zero rows for a course that has hundreds.
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
  where c.user_id = p_user_id
    and c.course_id = p_course_id
    and c.embedding is not null
    and (p_source is null or c.source = p_source)
    and (p_topic_id is null or c.topic_id = p_topic_id)
    -- A real session may only ask for itself. Null under service_role, where p_user_id is
    -- the only tenant evidence there is.
    and ((select auth.uid()) is null or (select auth.uid()) = p_user_id)
  order by c.embedding OPERATOR(extensions.<=>) p_query_embedding
  limit least(greatest(p_match_count, 1), 200)
$$;

comment on function public.match_chunks is
  'Cosine ANN retrieval over document_chunks for one tenant''s course, ordered by descending similarity. p_user_id is REQUIRED and filtered on: under the admin client (service_role) RLS is bypassed, so the function must carry its own tenant predicate rather than rely on RLS — see 20260720010830 for the reproduced cross-tenant leak. security invoker is retained so RLS still applies as a second layer for authenticated callers, and an authenticated caller may only pass its own uid. p_source / p_topic_id are optional narrowing filters; p_match_count is clamped to 1..200. Sets hnsw.iterative_scan = strict_order so the tenant and course filters cannot silently truncate the ANN result to zero — see 20260719182225.';
