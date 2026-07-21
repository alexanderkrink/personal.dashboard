-- ai_generations.schema_hash: the SIXTH stamp column (PLAN.md §AI Strategy §3, the Wave 5
-- correction "the five-column stamp UNDER-DETERMINES the model contract").
--
-- ## The gap this closes
--
-- The five-column stamp (prompt_id, prompt_version, provider, model, input_hash) is a
-- cryptographic receipt for the exact WORDS a model saw. It says nothing about the OUTPUT
-- CONTRACT the model was held to. The Zod output schema is compiled to a response schema and
-- sent alongside the prompt, and by packages/ai/src/schemas/index.ts's own rule its
-- `.describe()` text steers generation as much as the template does. So two attempts can
-- share ALL FIVE columns byte-for-byte while being governed by different schemas — a schema
-- edited without a prompt_version bump — and a frozen preimage receipt cannot see the drift.
-- Found the hard way in Wave 5 (topicMergePrompt), fixed there by one hand-bumped version.
--
-- ## What this column is
--
-- A SHA-256 (hex) of the CANONICAL JSON Schema of the Zod output schema for the call,
-- written by packages/ai next to input_hash. input_hash keeps meaning "the same words";
-- schema_hash makes "the same contract" separately queryable, and a cost/quality regression
-- traced through the stamp is attributable again.
--
-- ## Why nullable, and never backfilled
--
-- The recommended shape from PLAN's own note: "it can be backfilled as null rather than
-- invalidating every existing hash." Two populations legitimately carry NULL and must not be
-- confused with a real hash:
--   * historical rows written before this column existed;
--   * prose calls (AIRuntime.streamProse — chat/RAG/lesson prose) which have no schema at
--     all, so there is no contract to hash.
-- NULL therefore means "no schema governed this attempt". When present the value has the
-- same hex-64 shape as input_hash, enforced the same way.
--
-- ADD COLUMN is DDL, not a row UPDATE, so the append-only BEFORE UPDATE trigger on this
-- table (reject_ai_generations_update) does not fire and nothing here rewrites a cost record.
alter table public.ai_generations
  add column schema_hash text
    check (schema_hash is null or schema_hash ~ '^[0-9a-f]{64}$');

comment on column public.ai_generations.schema_hash is
  'SHA-256 (hex) of the canonical JSON Schema of the Zod output schema this attempt was held to — the sixth stamp column (PLAN §3, Wave 5 correction). NULL for prose calls with no schema and for rows predating the column; the five-column stamp under-determines the output contract without it.';
