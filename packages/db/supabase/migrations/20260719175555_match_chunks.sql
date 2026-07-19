-- match_chunks — the one retrieval surface over document_chunks (PLAN §6).
--
-- Powers course search, "ask your notes" chat with citations, and context
-- retrieval for the exam-review generator. Everything that reads embeddings goes
-- through here, so the ANN query, the course filter and the tenancy story exist
-- in exactly one place.
--
-- ## security invoker, and why that is the security model rather than a gap
--
-- The function is `security invoker` (PLAN §6 says so explicitly, and the
-- data-model Conventions make it the default: "security invoker unless a written
-- justification says otherwise"). It therefore runs with the CALLER's privileges,
-- which means the SELECT below is subject to document_chunks' RLS policies —
-- `(select auth.uid()) = user_id`. There is deliberately NO `where user_id = ...`
-- clause in the body: adding one would suggest RLS is not trusted here, and the
-- case that actually differs (a service-role caller, for whom RLS is off) would
-- not be fixed by it either — that caller is trusted by construction and scopes
-- itself.
--
-- The tenancy claim is verified rather than asserted: a cross-tenant call is
-- exercised as part of this wave's done conditions, with two tenants' chunks in
-- the table at once.
--
-- ## Why the operator is spelled OPERATOR(extensions.<=>)
--
-- `set search_path = ''` is a repo convention, and pgvector lives in the
-- `extensions` schema (20260719092113 put it there to avoid Supabase's
-- extension_in_public advisory). With an empty search_path an unqualified `<=>`
-- does not resolve at all. Operators cannot be schema-qualified with a dot, so
-- the OPERATOR(schema.op) form is the only spelling available — and it is the
-- form the HNSW index is matched against, so getting it wrong costs a sequential
-- scan rather than an error.

create function public.match_chunks(
  p_course_id uuid,
  p_query_embedding extensions.vector(1024),
  p_match_count int default 8,
  -- Optional narrowing. Null means "no filter", which is the common case; both
  -- live here so callers never hand-roll a second query against this table.
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
-- stable, not immutable: the result depends on table contents and, through RLS,
-- on auth.uid(). immutable would license the planner to cache across statements.
stable
security invoker
set search_path = ''
as $$
  select
    c.id,
    c.document_id,
    c.topic_id,
    c.source,
    c.content,
    c.locator,
    -- pgvector's <=> is cosine DISTANCE (0 = identical). Callers want SIMILARITY,
    -- so it is converted once here rather than in three call sites that could
    -- each get the direction wrong.
    (1 - (c.embedding OPERATOR(extensions.<=>) p_query_embedding))::real as similarity
  from public.document_chunks c
  where c.course_id = p_course_id
    -- Chunks are written by the chunk step and embedded by a later step, so an
    -- un-embedded row is a normal intermediate state, not an error. Excluded
    -- because <=> against null yields null and would sort as a phantom result.
    and c.embedding is not null
    and (p_source is null or c.source = p_source)
    and (p_topic_id is null or c.topic_id = p_topic_id)
  -- Distance, ascending — the exact expression the HNSW index is built on, which
  -- is what lets the planner use it instead of sorting the whole course.
  order by c.embedding OPERATOR(extensions.<=>) p_query_embedding
  -- Clamped rather than trusted. A caller passing 0 or a negative gets one row
  -- instead of a confusing empty set; a caller passing 10000 cannot turn a
  -- retrieval call into a full-course dump.
  limit least(greatest(p_match_count, 1), 200)
$$;

comment on function public.match_chunks is
  'Cosine ANN retrieval over document_chunks for one course, ordered by descending similarity. security invoker: RLS on document_chunks does the tenant filtering, so there is no user_id argument and no user_id predicate in the body. p_source / p_topic_id are optional narrowing filters; p_match_count is clamped to 1..200.';
