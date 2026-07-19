-- Two things `ai_generations` gets wrong the moment Wave 4 gives it real traffic.
--
-- Both are latent today only because the table has seen 8 rows, all Anthropic or
-- Google, all priced. Wave 4 adds the embedding calls and the pipeline volume
-- that make each of them false.

/* ────────────────────────────────────────────────────────────────────────── */
/* 1. `provider` could not name the embedding vendor                          */
/* ────────────────────────────────────────────────────────────────────────── */

-- `check (provider in ('anthropic','google'))` encodes the *generation* provider
-- split — the two families the §2 ladder escalates between. Embeddings are not
-- part of that split and never were: `packages/ai/src/pricing.ts` already carries
-- `EMBEDDING_PRICING` with `provider: "voyage"`, and PLAN §5 keeps embeddings
-- single-vendor on Voyage precisely *because* mixing embedding models breaks
-- vector comparability. So the first Voyage call would have hit this constraint
-- and failed to log, and the M1 DoD sentence "every AI call appears in
-- ai_generations with cost" would have become false without anything erroring in
-- a way a human would notice — the insert throws inside the metering hook, which
-- is the one place where an exception looks like a bug rather than a hole.
--
-- ## Why 'voyage' and ONLY 'voyage'
--
-- The temptation is to drop the constraint, or widen it to "any text", on the
-- reasoning that `model` is already unconstrained for exactly that flexibility.
-- Both are wrong here, and the difference is worth stating because it is the same
-- distinction `20260719113023` drew for `model`:
--
--   * `model` records WHAT RAN and must accept a value this migration has never
--     heard of, because re-pinning a job to a new model must never make a call
--     unloggable. Its domain is open by necessity.
--   * `provider` records WHO WAS PAID, and the set of vendors this project can be
--     billed by is small, deliberate, and changes only when someone signs up for
--     a new one. Its domain is closed by design. A typo here (`'anthropc'`,
--     `'Google'`) does not just mislabel a row — it silently forks the §6 rollup's
--     `group by provider, model` into a phantom vendor whose spend nobody looks at.
--
-- `'openai'` is deliberately absent. CLAUDE.md records `@ai-sdk/openai` as
-- deliberately unwired, and a constraint that accepts a provider the code cannot
-- call is a constraint that has stopped describing reality. Wiring OpenAI is a
-- decision, and this line is one of the places that decision should have to touch.
alter table public.ai_generations
  drop constraint ai_generations_provider_check;

alter table public.ai_generations
  add constraint ai_generations_provider_check
  check (provider in ('anthropic', 'google', 'voyage'));

comment on column public.ai_generations.provider is
  'The vendor that actually served this attempt and will bill for it. Not redundant with model: a job can be re-pointed to another provider, and the §6 rollup prices each call against its own provider table. Closed domain on purpose — anthropic and google are the two generation families, voyage is the embedding vendor (PLAN §5, single-vendor for vector comparability). openai is deliberately absent while @ai-sdk/openai stays unwired. Kept in step with AI_PROVIDER_NAMES in packages/ai/src/models.ts, which packages/ai/src/models.test.ts pins.';

/* ────────────────────────────────────────────────────────────────────────── */
/* 2. An unpriced call was money spent, counted as zero                       */
/* ────────────────────────────────────────────────────────────────────────── */

-- `ai_generations.cost_usd` is nullable and its own column comment is explicit
-- about why: "NULL = the provider reported no usage, which is distinct from a
-- genuine $0.00." The rollup then wrote `coalesce(sum(cost_usd), 0)` and threw
-- that distinction away at the group level.
--
-- `sum()` already skips NULLs, so the coalesce only ever fires when EVERY row in
-- a group is unpriced — and in that case it reports the group as costing exactly
-- nothing. The budget guard reads this view. A day on which metering broke and
-- forty real calls went out therefore looks, to the only circuit breaker in the
-- system, identical to a day on which nothing happened.
--
-- The fix is not to invent a price. There is no defensible number to substitute:
-- an unpriced attempt has no reported usage, so any figure would be fabricated,
-- and `pricing.ts` already refuses to invent a rate it was not given (see the ⚠
-- on Gemini's surcharged cache-read). The fix is to stop presenting an incomplete
-- sum as if it were a total. `cost_usd` stays what it is — a LOWER BOUND — and
-- the view now says so out loud by publishing how many calls it could not price.
--
-- `guard.ts` decides what to do with that count; see `SpendReading` and
-- `UNPRICED_TOLERANCE` there. The database's job is to make the ignorance
-- visible, not to resolve it.
--
-- Recreated rather than altered: a view's select list cannot be extended in
-- place. Definition is otherwise identical to `20260719113023`.
drop view public.ai_daily_cost;

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
  -- A LOWER BOUND on the day's spend, not the day's spend. `sum()` skips NULL
  -- rows; the coalesce only covers the all-NULL group. Read together with
  -- `unpriced_calls` or not at all.
  coalesce(sum(cost_usd), 0)::numeric(14, 8) as cost_usd,
  -- How much of `cost_usd` is missing, expressed as a count because that is the
  -- only honest unit available — the dollars are exactly what is unknown.
  -- Non-zero means the figure beside it under-reports by an unknown amount.
  count(*) filter (where cost_usd is null) as unpriced_calls
from public.ai_generations
group by user_id, ((created_at at time zone 'Europe/Madrid')::date), provider, model;

comment on view public.ai_daily_cost is
  'Daily cost per (user, day, provider, model) — the §6 rollup and the input to the AI_MONTHLY_BUDGET_USD guard. Plain view with security_invoker so RLS applies and the numbers are never stale. cost_usd is a LOWER BOUND: unpriced_calls counts the attempts in the group whose cost could not be determined, and a consumer that reads cost_usd without reading unpriced_calls will treat a metering outage as a zero bill.';
