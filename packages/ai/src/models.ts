/**
 * The model-per-job network (PLAN.md §AI Strategy §1).
 *
 * Call sites select a **job**, never a model ID — `getModel("topic-merge")`
 * resolves the job to its pinned `(provider, model)`. Re-pointing a job is a
 * one-line change in `JOBS`.
 *
 * Rules of thumb encoded here:
 * - **Google Gemini** for long-context/multimodal extraction (`gemini-3.1-pro-preview`)
 *   and high-volume classification (`gemini-3.1-flash-lite`).
 * - **Anthropic Claude** for generation, coding and user-facing chat (`claude-sonnet-5`),
 *   high-stakes synthesis (`claude-opus-4-8`), and a cheap cross-family critic
 *   (`claude-haiku-4-5`).
 *
 * Critics deliberately run on a *different family* than the generator they check —
 * two models from the same family share blind spots, two families don't. The one
 * Gemini-over-Gemini pairing (`coverage-checklist`) is deliberate: it matches syllabus
 * objectives against the Sonnet-built topic set, so the generator it checks is Sonnet.
 *
 * Providers wired through the Vercel AI SDK: @ai-sdk/anthropic + @ai-sdk/google.
 * (@ai-sdk/openai is deliberately NOT wired — OpenAI is a deferred third family, §1b.)
 */

/** Coarse capability ranks. Drive ONLY escalation, the AI_MAX_TIER clamp, and 429 failover. */
export const RANK = { fast: 0, balanced: 1, deep: 2 } as const;

export type Rank = keyof typeof RANK;

/**
 * The two **language-model** families, and deliberately nothing else.
 *
 * This type is narrow on purpose and must stay narrow. It is the `provider` field of
 * every entry in `MODELS`, so widening it widens what `satisfies` will accept there —
 * `"voyage-3.5-lite": { provider: "voyage", rank: "fast" }` would start type-checking as
 * a *language* model, and `getModel()` would happily hand an embedding model to
 * `generateObject`. The compiler is the only thing standing between a job registry and
 * that mistake, so it does not get relaxed for the convenience of a log column.
 */
export type ProviderName = "anthropic" | "google";

/**
 * Embedding vendors — a **separate axis**, not a third generation family.
 *
 * PLAN §5 keeps embeddings single-vendor on Voyage because mixing embedding models
 * breaks vector comparability, which is a retrieval property and has nothing to do with
 * the two-family split that §2's ladder escalates across or that critics are chosen
 * against. Voyage is not a fallback for Anthropic and Anthropic is not a fallback for
 * Voyage; they are not the same kind of thing and are not interchangeable anywhere.
 *
 * `packages/ai/src/pricing.ts` already models it this way — `EMBEDDING_PRICING` sits
 * outside `PRICING` rather than as another row in it — and this is the type half of the
 * same decision.
 */
export type EmbeddingProviderName = "voyage";

/**
 * Every vendor that may appear in `ai_generations.provider`: who was PAID, across both
 * axes. This is a metering/billing type, never a model-selection one — nothing resolves
 * a call through it, so it can be the union without endangering `MODELS`.
 *
 * Kept in step with the `ai_generations_provider_check` constraint in
 * `20260719155004_ai_generations_embedding_provider_and_unpriced_calls.sql`. The two
 * drifting is how "every AI call appears in `ai_generations` with cost" (the M1 DoD)
 * goes quietly false: the row that cannot be logged is the row nobody sees is missing.
 */
export type AIProviderName = ProviderName | EmbeddingProviderName;

/** The runtime list, for validating a provider read back from outside the type system. */
export const AI_PROVIDER_NAMES = [
  "anthropic",
  "google",
  "voyage",
] as const satisfies readonly AIProviderName[];

export const MODELS = {
  "gemini-3.1-flash-lite": { provider: "google", rank: "fast" },
  "claude-haiku-4-5": { provider: "anthropic", rank: "fast" },
  "claude-sonnet-5": { provider: "anthropic", rank: "balanced" },
  // 🔴 PLAN.md §1 pins this to the model ID `gemini-3.1-pro`, which returns HTTP 404
  // ("not found for API version v1beta") against the live Generative Language API as of
  // 2026-07-19. `gemini-3.1-pro-preview` is the only live Gemini 3.1 Pro ID and is what
  // ships here. See the 🔴 DISPROVEN marker in PLAN.md §1. Re-pin to the stable ID the
  // day Google promotes it — this line and the JOBS entry are the only things that change.
  "gemini-3.1-pro-preview": { provider: "google", rank: "deep" },
  "claude-opus-4-8": { provider: "anthropic", rank: "deep" },
} as const satisfies Record<string, { provider: ProviderName; rank: Rank }>;

export type ModelId = keyof typeof MODELS;

/**
 * Every job names its model explicitly — the single source of truth for call sites.
 * Adding a job here is what makes `getModel("new-job")` type-check.
 */
export const JOBS = {
  "doc-structuring": "gemini-3.1-pro-preview", // long-context + multimodal extraction
  "deep-review-audit": "claude-opus-4-8", // independent 2nd reader — different family from the extractor
  "topic-routing": "gemini-3.1-flash-lite",
  "topic-merge": "claude-sonnet-5",
  "merge-critic": "gemini-3.1-flash-lite", // cross-family over the Sonnet merge
  "coverage-checklist": "gemini-3.1-flash-lite",
  "cards-basic": "gemini-3.1-flash-lite",
  "cards-mcq-numeric": "claude-sonnet-5",
  "card-critic": "claude-haiku-4-5", // cross-family over the Gemini-generated basic/cloze cards
  "card-critic-objective": "gemini-3.1-flash-lite", // cross-family over the Sonnet-generated MCQ/numeric cards
  "case-brief": "claude-opus-4-8",
  "mock-exam-objective": "claude-sonnet-5",
  "mock-exam-open": "claude-opus-4-8",
  "quiz-grading": "gemini-3.1-flash-lite", // short in-session answers
  "grade-exam-answer": "claude-sonnet-5", // mock-exam open answers vs a full rubric
  "chat-rag": "claude-sonnet-5", // stays on Anthropic to keep prompt-cache economics (§5)
  "lesson-generate": "claude-sonnet-5",
  "code-feedback": "claude-sonnet-5",
  "exam-review": "claude-opus-4-8",
  "quick-add": "gemini-3.1-flash-lite",
  "glossary-extract": "claude-sonnet-5",
  "glossary-critic": "gemini-3.1-flash-lite", // cross-family over the Sonnet glossary extraction
  "capture-route": "gemini-3.1-flash-lite",
  "recap-quiz": "gemini-3.1-flash-lite", // Today Queue 2-min recap
  "exercise-hint": "gemini-3.1-flash-lite",
  "exercise-variant": "gemini-3.1-flash-lite",
  "syllabus-outline": "claude-sonnet-5",
  "syllabus-components": "claude-sonnet-5",
  "topic-effort-estimate": "claude-sonnet-5", // exam planner: est-minutes/difficulty pre-fill
  "study-plan": "claude-sonnet-5",
  "cold-call-drill": "claude-sonnet-5",
  "cold-call-rubric": "claude-sonnet-5",
  "attendance-summary": "gemini-3.1-flash-lite", // optional M4 weekly participation digest
} as const satisfies Record<string, ModelId>;

export type JobId = keyof typeof JOBS;

/** All model IDs. Stable iteration order (declaration order in `MODELS`). */
export const MODEL_IDS = Object.keys(MODELS) as readonly ModelId[];

/** All job IDs. Stable iteration order (declaration order in `JOBS`). */
export const JOB_IDS = Object.keys(JOBS) as readonly JobId[];

/** What a job resolves to. Pure data — no SDK instance, no key, no I/O. */
export interface ModelResolution {
  readonly job: JobId;
  readonly model: ModelId;
  readonly provider: ProviderName;
  readonly rank: Rank;
}

/**
 * Resolves a job to its pinned `(provider, model)`.
 *
 * This is the ONLY way a call site is allowed to name a model. It is pure and
 * synchronous so it can be unit-tested and reasoned about without any provider
 * wiring; `AIRuntime.languageModel(job)` turns the result into an SDK model.
 *
 * `maxRank` implements the `AI_MAX_TIER` clamp (§6): a job pinned above the clamp is
 * forced down to the highest-rank model at or below it, preferring the same provider
 * so the clamp doesn't silently change a job's caching economics or rate-limit pool.
 */
export function getModel(job: JobId, options?: { maxRank?: Rank }): ModelResolution {
  const model = JOBS[job];
  const spec = MODELS[model];
  const maxRank = options?.maxRank;

  if (maxRank === undefined || RANK[spec.rank] <= RANK[maxRank]) {
    return { job, model, provider: spec.provider, rank: spec.rank };
  }

  const clamped = bestModelAtOrBelow(maxRank, spec.provider);
  return { job, model: clamped, provider: MODELS[clamped].provider, rank: MODELS[clamped].rank };
}

/** Highest-rank model at or below `maxRank`, preferring `preferProvider`. */
function bestModelAtOrBelow(maxRank: Rank, preferProvider: ProviderName): ModelId {
  const eligible = MODEL_IDS.filter((id) => RANK[MODELS[id].rank] <= RANK[maxRank]);
  const sameProvider = eligible.filter((id) => MODELS[id].provider === preferProvider);
  const pool = sameProvider.length > 0 ? sameProvider : eligible;

  const best = pool[0];
  if (best === undefined) {
    // Unreachable: `fast` is the lowest rank and both providers have a fast model.
    throw new Error(`No model at or below rank "${maxRank}"`);
  }
  return pool.reduce((a, b) => (RANK[MODELS[b].rank] > RANK[MODELS[a].rank] ? b : a), best);
}

/**
 * The escalation target for the structured-output failure ladder (§2 step 2).
 *
 * Picks the next rank up that has a model, and **prefers a different provider** at that
 * rank: a schema failure on one model family often clears on another, and a failure both
 * families reject is almost always a schema bug rather than model flakiness. Cross-provider
 * is a preference, not a hard rule — if no other family has a model at the next rank
 * (Haiku → Sonnet, both Anthropic), a same-provider step up still beats giving up.
 *
 * Returns `undefined` when there is nowhere to escalate: the model is already at the top
 * rank, or `maxRank` (the AI_MAX_TIER clamp) forbids the step. The caller must then
 * dead-letter — it must NEVER loop.
 */
export function escalationTarget(from: ModelId, options?: { maxRank?: Rank }): ModelId | undefined {
  const current = MODELS[from];
  const ceiling = options?.maxRank === undefined ? RANK.deep : RANK[options.maxRank];

  const higher = MODEL_IDS.filter((id) => {
    const rank = RANK[MODELS[id].rank];
    return rank > RANK[current.rank] && rank <= ceiling;
  });
  if (higher.length === 0) return undefined;

  const targetRank = higher.reduce(
    (lowest, id) => Math.min(lowest, RANK[MODELS[id].rank]),
    RANK.deep as number,
  );
  const atTarget = higher.filter((id) => RANK[MODELS[id].rank] === targetRank);

  return atTarget.find((id) => MODELS[id].provider !== current.provider) ?? atTarget[0];
}
