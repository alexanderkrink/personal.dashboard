-- ai_generations: the append-only log every LLM call lands in, plus the daily
-- cost rollup the budget guard reads (PLAN.md §AI Strategy §3, §5, §6).
--
-- ## What a row is
--
-- One ATTEMPT, not one logical call. The §2 failure ladder can burn up to three
-- attempts (initial -> corrective-retry -> escalation) and every one of them costs
-- money, so every one of them gets a row. That is also why `model` is stored per
-- row rather than derived from `job`: an escalated attempt runs on a different
-- model than the job is pinned to, and the log records what actually ran.
--
-- ## The five-column stamp (§3)
--
-- prompt_id, prompt_version, provider, model, input_hash. `provider` is NOT
-- redundant with `model`: §3 is explicit that a job can be re-pointed to a
-- different provider later, and the §6 rollup prices each call against its own
-- provider's table — so the stamp must record the provider that actually served
-- the request, not the one today's registry would name.
--
-- ## Why there is no `updated_at`
--
-- The data-model Conventions list `ai_generations` among the append-only logs.
-- Those tables are never updated after insert, so they carry no `updated_at` and
-- get no `set_updated_at` trigger.
--
-- ## Append-only is ENFORCED, not documented
--
-- A comment saying "append-only" stops nobody. RLS stops nobody either: the
-- writer here is `createAdminSupabaseClient`, which bypasses RLS entirely, and it
-- is exactly the code that must not be able to rewrite a cost record. So the
-- invariant lives in a BEFORE UPDATE trigger, which fires for the service role,
-- for `postgres`, and for the SQL editor alike.
--
-- DELETE is deliberately NOT blocked, and this is not an oversight:
-- `user_id references auth.users (id) on delete cascade` means deleting a user
-- issues a DELETE against this table. A trigger that raised on DELETE would make
-- user deletion fail outright — trading a real requirement for a weaker version
-- of an invariant that only matters for UPDATE anyway. The property worth
-- enforcing is "a recorded call can never be rewritten"; retention pruning and
-- the auth cascade are legitimate deletes.

create table public.ai_generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  -- ── The §3 five-column stamp ────────────────────────────────────────────────
  -- Kebab-case, stable, and equal to the key of the job that runs it (§3), with an
  -- optional variant suffix (`lesson-generate-repair`).
  prompt_id text not null check (prompt_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  prompt_version integer not null check (prompt_version >= 1),
  provider text not null check (provider in ('anthropic', 'google')),
  -- Deliberately UNCONSTRAINED. A check against today's five model IDs would turn
  -- "we pinned a job to a new model" into "logging throws until a migration lands",
  -- and a call that cannot be logged is a hole in the budget guard. The registry in
  -- packages/ai/src/models.ts is the source of truth for what may be CALLED; this
  -- column's job is to record what WAS called, including a model this migration
  -- has never heard of.
  model text not null,
  -- SHA-256 of the rendered prompt, hex. Drives the §5 idempotency short-circuit,
  -- so a malformed hash is a bug worth rejecting at the boundary.
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),

  -- ── Which job, and where in the ladder ─────────────────────────────────────
  job text not null check (job ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  step text not null check (step in ('initial', 'corrective-retry', 'escalation')),
  -- 1..3 encodes "the ladder is exactly three rungs and NEVER loops" (§2) as a
  -- database constraint rather than as a property of one TypeScript function.
  attempt integer not null check (attempt between 1 and 3),
  -- 'transport-error' has no producer yet and that is intentional. §6 wants a
  -- transport-killed attempt persisted, but that record has to be written by the
  -- Inngest step wrapper (where the NonRetriableError decision lives), not by
  -- packages/ai — an attempt that never completes never reaches the metering hook.
  -- Accepting the value now means closing that gap is a code change, not a migration.
  outcome text not null
    check (outcome in ('success', 'schema-failure', 'refusal', 'transport-error')),

  -- ── §5 token usage ─────────────────────────────────────────────────────────
  -- `input_tokens` EXCLUDES cached tokens: some providers fold cache reads into
  -- their input count, and billing those at the full input rate would overstate
  -- every cached call. packages/ai normalizes this before it gets here.
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cache_read_tokens integer not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens integer not null default 0 check (cache_write_tokens >= 0),
  latency_ms integer not null check (latency_ms >= 0),

  -- ── Cost ───────────────────────────────────────────────────────────────────
  -- Priced at WRITE time by `priceUsd()` in packages/ai/src/pricing.ts, against the
  -- concrete (provider, model) above. Deliberately not computed in SQL: there is no
  -- single price table anymore (two providers), and pricing.ts already models the
  -- two subtleties a SQL copy would flatten — gemini-3.1-pro-preview's >200K
  -- long-context bracket and Sonnet's opt-in introductory rates. Duplicating that
  -- here would be a second source of truth that silently drifts.
  --
  -- Storing it also makes the log historically honest: a price change tomorrow does
  -- not retroactively rewrite what yesterday cost.
  --
  -- NULL means "the provider reported no usage for this attempt" — which is not the
  -- same as $0.00, and the rollup must not average it in as if it were. numeric(14,8)
  -- because the cheapest real call (a ~1K-token Flash-Lite classification) lands
  -- around $0.0004 and rounding that to zero would make the cheap tier invisible.
  cost_usd numeric(14, 8) check (cost_usd >= 0),

  -- ── Failure evidence (§2 rung 3) ───────────────────────────────────────────
  -- The dead-letter rung persists the raw `.text` — for a schema failure it is the
  -- only evidence of what the model actually said.
  raw_text text,
  error_message text,

  created_at timestamptz not null default now()
);

comment on table public.ai_generations is
  'Append-only log of every LLM attempt: the §3 five-column stamp, token usage, latency, cost priced at write time, and raw text/error on failure. One row per ladder ATTEMPT, not per logical call. UPDATE is blocked by a trigger; there is no updated_at by design.';

comment on column public.ai_generations.provider is
  'The provider that actually served this attempt. Not redundant with model: a job can be re-pointed to another provider, and the §6 rollup prices each call against its own provider table.';

comment on column public.ai_generations.cost_usd is
  'USD, priced at write time by priceUsd() in packages/ai/src/pricing.ts. NULL = the provider reported no usage, which is distinct from a genuine $0.00.';

-- ── Append-only enforcement ───────────────────────────────────────────────────
--
-- security invoker (the default): the trigger needs no elevated rights — it reads
-- nothing and writes nothing, it only refuses. Fully qualified names and an empty
-- search_path per repo convention.
create function public.reject_ai_generations_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'ai_generations is append-only: UPDATE is not permitted (row %)', old.id
    using errcode = 'restrict_violation';
end;
$$;

comment on function public.reject_ai_generations_update() is
  'Makes ai_generations append-only structurally rather than by convention. Fires for the service role too, which is the point: the RLS-bypassing admin client is the writer.';

create trigger ai_generations_no_update
  before update on public.ai_generations
  for each row execute function public.reject_ai_generations_update();

-- ── RLS ───────────────────────────────────────────────────────────────────────
--
-- Four per-operation policies, subquery form for per-statement caching, per the
-- RLS strategy's rule 1 ("no exceptions for internal tables — ai_generations and
-- job tables included").
--
-- Two of the four are near-inert on purpose, and that is worth naming rather than
-- hiding: the real writer is the RLS-bypassing admin client, and UPDATE is refused
-- by the trigger above no matter which policy would have allowed it. They exist so
-- that ownership scoping on this table looks exactly like every other table, which
-- is what makes a missing policy anywhere else visible as an anomaly.
alter table public.ai_generations enable row level security;

create policy "Users can view own ai generations"
  on public.ai_generations
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert own ai generations"
  on public.ai_generations
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update own ai generations"
  on public.ai_generations
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete own ai generations"
  on public.ai_generations
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ── Indexes ───────────────────────────────────────────────────────────────────
--
-- user_id is the only foreign key on this table (-> auth.users), and gate 1's
-- finding in Wave 1 was that an FK index has to cover the column that actually
-- serves the lookup. Both things that read this table lead with user_id:
--   * the budget guard: "month-to-date spend for this user", a range scan on
--     created_at within one user;
--   * the auth.users ON DELETE CASCADE, which needs user_id indexed or it degrades
--     to a sequential scan of the whole log on every user deletion.
-- One composite index (user_id, created_at desc) serves both, so there is no
-- separate single-column user_id index to maintain.
create index ai_generations_user_created_idx
  on public.ai_generations (user_id, created_at desc);

-- §3's targeted-regeneration and eval-by-diff queries: "everything this prompt
-- produced below version N". Leads with user_id for the same tenancy reason.
create index ai_generations_user_prompt_version_idx
  on public.ai_generations (user_id, prompt_id, prompt_version);

-- ── The daily cost rollup (§6) ────────────────────────────────────────────────
--
-- A plain VIEW, not a materialized view and not an ad-hoc query. Deliberate:
--
--   * vs. a MATERIALIZED view — a matview cannot carry RLS (it is owned by the
--     definer and policies do not apply), so it would leak one tenant's spend to
--     another the moment a second user exists, and it would need a refresh
--     schedule. Worse, it would be STALE: this view is the input to the budget
--     guard, and a rollup that lags is wrong exactly when spend is spiking, which
--     is the only moment the guard matters.
--   * vs. an ad-hoc query in TypeScript — §6 asks for a rollup that "materializes
--     cost-per-day per (provider, model)"; putting that grouping in one named
--     object means the guard, any future dashboard, and a psql session all read
--     the same definition.
--   * the volume argument: at PLAN §4's projected load this table takes on the
--     order of a few thousand rows a month. Aggregating that live is microseconds,
--     and (user_id, created_at desc) already covers the scan. Materializing would
--     buy nothing and cost freshness.
--
-- security_invoker = true so the querying user's own policies apply (RLS strategy
-- rule 4). The background guard reads it through the admin client, which bypasses
-- RLS as usual and therefore must filter by user_id itself.
--
-- `day` is the LOCAL date in Europe/Madrid, matching the calendar spine's decision
-- (§3.4) to do timezone work once and treat Madrid as the app's civil calendar. A
-- UTC day boundary would put a 01:00 Madrid call on the previous day, which reads
-- wrong on a per-day spend chart.
create view public.ai_daily_cost
with (security_invoker = true) as
select
  user_id,
  ((created_at at time zone 'Europe/Madrid')::date) as day,
  provider,
  model,
  count(*) as calls,
  count(*) filter (where outcome = 'success') as successes,
  sum(input_tokens)::bigint as input_tokens,
  sum(output_tokens)::bigint as output_tokens,
  sum(cache_read_tokens)::bigint as cache_read_tokens,
  sum(cache_write_tokens)::bigint as cache_write_tokens,
  -- Rows with no reported usage contribute NULL, not 0; coalesce at the group level
  -- so a day of un-metered attempts sums to 0 rather than to NULL.
  coalesce(sum(cost_usd), 0)::numeric(14, 8) as cost_usd
from public.ai_generations
group by user_id, ((created_at at time zone 'Europe/Madrid')::date), provider, model;

comment on view public.ai_daily_cost is
  'Daily cost per (user, day, provider, model) — the §6 rollup and the input to the AI_MONTHLY_BUDGET_USD guard. Plain view with security_invoker so RLS applies and the numbers are never stale.';
