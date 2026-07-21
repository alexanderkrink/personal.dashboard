-- The frozen routing receipt that makes a re-entering merge idempotent
-- (PLAN "Document & Notes Pipeline" §3; Wave 7 §3 resumability fix).
--
-- ## The defect this closes
--
-- `runRouteAndMerge` ran all of merge Steps A–C as ONE Inngest step. On the
-- failing production run (.local-fixtures/wave7-section3) pass 1 routed 48
-- segments on an EMPTY index into 8 create targets, created 4 of them, then the
-- step died silently at ~300s. Inngest retried the step; routing re-read the
-- extraction and RE-ROUTED from scratch against the now-non-empty 4-topic index,
-- so all 48 segments assigned INTO the 4 existing topics; `planMergeWork` skipped
-- all 4 as "already includes this file", and the 4 never-created topics plus ~24
-- pages evaporated while the document finalized `ready`.
--
-- The fix persists the resolved plan under a hash of the EXTRACTION (not the
-- routing input) so a re-entry LOADS the same plan instead of re-routing against
-- a half-built index, and each merge target becomes its own memoized step so a
-- retry resumes at target 5-of-8 rather than re-running 1–4.
--
-- ## Why `extraction_hash`, not the routing `input_hash`
--
-- The routing call's `input_hash` is INDEX-DEPENDENT: the two `topic-routing`
-- rows for the failing document share `prompt_version = 5` but carry different
-- `input_hash` values (0ad4c8d9… on pass 1 vs 84b35a27… on pass 2) precisely
-- because the topic index changed between passes. Keying the plan on that hash
-- would mint a fresh key on every retry — the opposite of a frozen receipt.
-- `extraction_hash` is a sha256 over a canonical (stable-key-ordered)
-- serialization of `documents.extraction`, which does NOT change between passes,
-- so it is the stable identity of "the same document, extracted the same way".
-- It is computed in the application; this table only stores it.
--
-- ## Conventions
--
-- Tenant-scoped composite FK (document_id, user_id) against documents' existing
-- (id, user_id) unique key — RLS-strategy rule 7, exactly as every FK in
-- 20260719175553 (document_pipeline_tables). The only writer on this path is an
-- Inngest job holding the service key, where RLS is not in the path at all, so
-- the composite FK is what actually stops a plan row from pointing at another
-- tenant's document. RLS still carries the conventional four per-operation
-- policies scoped to `(select auth.uid()) = user_id`.
--
-- Safe to apply as written: the table is new, so there is no backfill and nothing
-- to reject. The only pre-existing object touched is documents, and only as the
-- read-only target of its existing (id, user_id) key.

/* ========================================================================== */
/* 1. document_merge_plans — one frozen plan per (document, extraction, prompt) */
/* ========================================================================== */

create table public.document_merge_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  document_id uuid not null,

  -- sha256 of a canonical (stable-key-ordered) serialization of
  -- documents.extraction. Index-INDEPENDENT and stable across passes — see the
  -- header. NOT the routing input_hash.
  extraction_hash text not null,

  -- The topic-routing prompt version the plan was resolved under (5 today). A
  -- prompt bump is a semantically different routing, so it takes a fresh plan
  -- rather than reusing one resolved by an older router.
  prompt_version int not null,

  -- The resolved post-guard / post-coalesce plan: the merge targets (stable key,
  -- assign-to-topic-id or create, the segment keys that feed each) plus the
  -- document-level metadata a re-entry needs (unaccounted pages, coverage-checked
  -- flag, backstop findings). A completed create writes its resulting topic id
  -- back into its target here, so a later run resolves that create to a skip
  -- instead of creating a duplicate topic.
  plan jsonb not null,

  created_at timestamptz not null default now(),
  -- No updated_at: the plan column is patched in place with resolved create ids,
  -- but the row is identified by (document_id, extraction_hash, prompt_version)
  -- and carries no independent lifecycle worth stamping — the same reasoning
  -- topic_sources uses for its in-place `locators` rewrite.

  -- The frozen-receipt key: at most one plan per document per extraction per
  -- router version. `resolve-merge-plan` looks a plan up by exactly this triple
  -- and, when it is present, performs ZERO routing calls.
  constraint document_merge_plans_document_extraction_prompt_key
    unique (document_id, extraction_hash, prompt_version),

  -- Tenant-scoped (rule 7). ON DELETE CASCADE: deleting the document deletes its
  -- frozen plan. The FK's leading column (document_id) matches the leading column
  -- of the unique index above, so that index also covers the referential scan a
  -- document delete performs — no separate FK index is needed, the same move
  -- attendance_records made with its own unique key in 20260720222423.
  constraint document_merge_plans_document_id_fkey foreign key (document_id, user_id)
    references public.documents (id, user_id) on delete cascade
);

comment on table public.document_merge_plans is
  'Frozen routing receipt (Wave 7 §3): the resolved post-guard/post-coalesce merge plan for a document, keyed by a canonical hash of its extraction. A re-entering process-document run LOADS this instead of re-routing against a half-built topic index, which is what stops the non-idempotent-retry data loss.';

comment on column public.document_merge_plans.extraction_hash is
  'sha256 of a canonical stable-key-ordered serialization of documents.extraction. Index-INDEPENDENT and stable across passes, unlike the topic-routing input_hash. Computed in the application.';

comment on column public.document_merge_plans.plan is
  'The resolved merge targets (stable key, assign/create, feeding segment keys) plus document-level metadata. A completed create writes its resulting topic id back here so a later run resolves it to a skip rather than a duplicate create.';

/* ========================================================================== */
/* 2. Row-level security — four per-operation policies                        */
/* ========================================================================== */

-- The init_profiles pattern: per-operation policies (never FOR ALL), scoped
-- `to authenticated`, subquery form `(select auth.uid())` for per-statement
-- caching. The job writer uses the service key and is unaffected by these; they
-- exist so a session caller can only ever see or touch its own plans.

alter table public.document_merge_plans enable row level security;

create policy "Users can view own merge plans"
  on public.document_merge_plans for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert own merge plans"
  on public.document_merge_plans for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update own merge plans"
  on public.document_merge_plans for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete own merge plans"
  on public.document_merge_plans for delete
  to authenticated
  using ((select auth.uid()) = user_id);
