/**
 * Per-provider price tables (PLAN.md §AI Strategy §1, "Pricing (verified July 2026)").
 *
 * Two providers means **there is no single price table anymore** — Anthropic and Gemini
 * rates sit side by side and every call is priced against its own provider's sticker.
 * `ai_generations` stamps the concrete `(provider, model)` precisely so the daily rollup
 * can do this lookup. Agent 3 (M1 item 2c) builds that rollup on top of `priceUsd`.
 *
 * All rates are **USD per million tokens**.
 *
 * Two subtleties this module deliberately does NOT flatten:
 * 1. `gemini-3.1-pro-preview` carries a **long-context surcharge above 200K prompt tokens**
 *    ($2/$12 under, $4/$18 over). Modelled as two brackets, not an average.
 * 2. `claude-sonnet-5` has **introductory pricing through 2026-08-31** ($2/$10), but the
 *    plan's cost math deliberately uses the durable $3/$15 sticker. So the intro rates are
 *    recorded and are **opt-in only** — `priceUsd` bills at the sticker unless you ask for
 *    the promotional rate. Budgeting against a rate that expires is how you get surprised.
 */

import type { EmbeddingProviderName, MODELS, ModelId } from "./models";

/** USD per million tokens. `cacheWrite: null` = the provider has no per-token write charge. */
export interface TokenRates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  /**
   * Anthropic bills cache writes at 1.25x input. Google's context caching bills storage
   * per hour rather than a per-token write, so it is `null` here rather than 0 — "not
   * charged this way" is different from "free", and §1's table states no write rate for
   * Gemini. Do not invent one; price Gemini cache storage separately if it ever matters.
   */
  readonly cacheWrite: number | null;
}

/** Introductory/promotional pricing with a hard expiry. Never the default. */
export interface IntroductoryPricing {
  readonly rates: TokenRates;
  /** Inclusive last day the promotional rates apply, ISO `YYYY-MM-DD`. */
  readonly through: string;
}

export interface ModelPricing {
  readonly provider: (typeof MODELS)[ModelId]["provider"];
  /** Max prompt tokens the model accepts. */
  readonly contextTokens: number;
  /** The durable sticker rates. Under `thresholdTokens` when a threshold exists. */
  readonly rates: TokenRates;
  /**
   * Long-context surcharge: above `thresholdTokens` **prompt** tokens, the whole call
   * (input *and* output) bills at `overThresholdRates`. Absent = flat pricing.
   */
  readonly longContext?: {
    readonly thresholdTokens: number;
    readonly overThresholdRates: TokenRates;
  };
  /** Present only while a promotion is live. Opt-in at the call site. */
  readonly introductory?: IntroductoryPricing;
  /** Multiplier for the provider's batch API, where §1 records one. Offline work only. */
  readonly batchMultiplier?: number;
}

export const PRICING = {
  "gemini-3.1-flash-lite": {
    provider: "google",
    contextTokens: 1_048_576,
    rates: { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: null },
  },
  "claude-haiku-4-5": {
    provider: "anthropic",
    contextTokens: 200_000,
    rates: { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
  },
  "claude-sonnet-5": {
    provider: "anthropic",
    contextTokens: 1_048_576,
    // The durable sticker. §1 footnote 1: all plan math uses $3/$15, not the promo rate.
    rates: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
    introductory: {
      rates: { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 },
      through: "2026-08-31",
    },
    batchMultiplier: 0.5,
  },
  "gemini-3.1-pro-preview": {
    provider: "google",
    contextTokens: 1_048_576,
    rates: { input: 2.0, output: 12.0, cacheRead: 0.2, cacheWrite: null },
    longContext: {
      thresholdTokens: 200_000,
      // ⚠ §1 states the surcharged input/output rates ($4/$18) but gives a single
      // cache-read rate ($0.20) with no surcharged variant. Carried through unchanged
      // rather than inferred — an invented number in a cost table is worse than a
      // conservative one. Verify against Google's published rate before the rollup
      // starts pricing >200K calls in anger.
      overThresholdRates: { input: 4.0, output: 18.0, cacheRead: 0.2, cacheWrite: null },
    },
  },
  "claude-opus-4-8": {
    provider: "anthropic",
    contextTokens: 1_048_576,
    rates: { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
    batchMultiplier: 0.5,
  },
} as const satisfies Record<ModelId, ModelPricing>;

/**
 * Embeddings stay single-vendor on Voyage regardless of the two-provider LLM split —
 * mixing embedding models breaks vector comparability (§5), so the provider decision is
 * about *generation*, never retrieval. Wave 4 builds the embedding calls; this is here so
 * the cost rollup has one place to look for every rate.
 *
 * First 200M tokens per account are free, so at this project's volume (~1M tok/month)
 * embeddings are effectively $0 for years.
 */
export const EMBEDDING_PRICING = {
  "voyage-3.5-lite": { provider: "voyage", inputPerMTok: 0.02, freeAllowanceTokens: 200_000_000 },
} as const satisfies Record<
  string,
  { provider: EmbeddingProviderName; inputPerMTok: number; freeAllowanceTokens: number }
>;

export type EmbeddingModelId = keyof typeof EMBEDDING_PRICING;

/**
 * Cost of one embedding call in USD.
 *
 * ## Why this bills at the sticker rather than at $0
 *
 * Voyage's first 200M tokens per account are free, and at this project's volume that is
 * years of runway — so the *tempting* implementation returns 0 and the budget page shows a
 * clean zero. That is the same mistake `ratesFor` refuses to make with Sonnet's
 * introductory rates, one axis over: **the free allowance is an account credit, not a
 * rate.** It is consumed exactly once, it is invisible from inside this function (nothing
 * here knows the account's lifetime token count), and the day it runs out every embedding
 * call silently starts costing money that a hard-coded 0 would keep reporting as free.
 *
 * So `cost_usd` records what the tokens are worth at the published rate and the free
 * allowance is treated as what it is — a credit applied to the bill, not a property of the
 * call. The number is tiny either way (1M tokens = $0.02), which is precisely why paying
 * the honesty is cheap.
 *
 * This closes the gap flagged when `ai_generations.provider` was widened to admit
 * `voyage`: there was a provider column that could name the vendor and no `priceUsd` path
 * that could price it, so the first embedding row would have landed with `cost_usd = NULL`
 * and quietly spent the guard's `UNPRICED_TOLERANCE` budget on calls that are in fact
 * perfectly priceable.
 */
export function embeddingPriceUsd(model: EmbeddingModelId, tokens: number): number {
  return (tokens * EMBEDDING_PRICING[model].inputPerMTok) / PER_MILLION;
}

/** Token counts for one call, as reported by the provider. */
export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

export interface PriceOptions {
  /**
   * Bill at introductory rates if a promotion is live on this date. Off by default:
   * §1's math and the budget guard use the durable sticker so a promo expiry can't
   * silently blow the monthly cap.
   */
  readonly introductoryAsOf?: Date;
  /** Apply the provider's batch discount. Offline work only — never interactive calls. */
  readonly batch?: boolean;
}

const PER_MILLION = 1_000_000;

/**
 * The prompt-token count that decides the long-context bracket: everything sent *to* the
 * model, cached or not. Output tokens don't enlarge the prompt and don't select the bracket
 * — but once selected, the bracket's rate applies to output too.
 */
function promptTokens(usage: TokenUsage): number {
  return usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

/** The rates in force for this model, given prompt size and the options. */
export function ratesFor(model: ModelId, usage: TokenUsage, options?: PriceOptions): TokenRates {
  const pricing: ModelPricing = PRICING[model];

  const intro = pricing.introductory;
  if (intro !== undefined && options?.introductoryAsOf !== undefined) {
    // Inclusive of the final day: compare date-only, in UTC, so a local timezone can't
    // move the expiry by a day.
    const asOf = options.introductoryAsOf.toISOString().slice(0, 10);
    if (asOf <= intro.through) return intro.rates;
  }

  const lc = pricing.longContext;
  if (lc !== undefined && promptTokens(usage) > lc.thresholdTokens) return lc.overThresholdRates;

  return pricing.rates;
}

/**
 * Cost of one call in USD.
 *
 * A `cacheWrite` count on a model with no per-token write rate (Gemini) contributes 0 and
 * is not silently billed at the input rate — see `TokenRates.cacheWrite`.
 */
export function priceUsd(model: ModelId, usage: TokenUsage, options?: PriceOptions): number {
  const pricing: ModelPricing = PRICING[model];
  const rates = ratesFor(model, usage, options);
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;

  const cost =
    (usage.input * rates.input +
      usage.output * rates.output +
      cacheRead * rates.cacheRead +
      cacheWrite * (rates.cacheWrite ?? 0)) /
    PER_MILLION;

  const batchMultiplier = pricing.batchMultiplier;
  if (options?.batch === true && batchMultiplier !== undefined) return cost * batchMultiplier;
  return cost;
}
