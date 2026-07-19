import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { MODELS, type ModelId, type ProviderName } from "./models";

/**
 * The two-provider core (PLAN.md §AI Strategy §1b).
 *
 * `@ai-sdk/anthropic` + `@ai-sdk/google`. **`@ai-sdk/openai` is deliberately NOT wired**:
 * GPT-5.6 sits squeezed between these two on every axis today, so a third SDK, a third
 * caching model, a third price table and a third key/rate-limit pool buys little. Adding
 * it is a one-file change here plus an env key, if an eval ever shows it winning a job.
 *
 * **This package never reads `process.env`** — the calling app injects both keys (see
 * `apps/web/src/env.ts`). That is what keeps `@study/ai` runnable anywhere: node, edge,
 * a test, a script.
 */
export interface AIProviderConfig {
  readonly anthropicApiKey: string;
  readonly googleApiKey: string;
}

export type AIProviders = {
  readonly [K in ProviderName]: (modelId: string) => LanguageModel;
};

/**
 * Instantiates both providers from injected keys.
 *
 * Both are always constructed: a job pinned to one provider can escalate or fail over to
 * the other (§2 step 2, §6 interactive degradation), so having only one wired would turn
 * a recoverable failure into a dead-letter.
 */
export function createAIProvider(config: AIProviderConfig): AIProviders {
  const anthropic = createAnthropic({ apiKey: config.anthropicApiKey });
  const google = createGoogleGenerativeAI({ apiKey: config.googleApiKey });
  return {
    anthropic: (modelId) => anthropic(modelId),
    google: (modelId) => google(modelId),
  };
}

/**
 * Turns a concrete model ID into an AI SDK language model, routed to the provider that
 * owns it. Call sites never reach this directly — they go through `AIRuntime`, which
 * resolves a *job* first.
 */
export function languageModelFor(providers: AIProviders, model: ModelId): LanguageModel {
  return providers[MODELS[model].provider](model);
}
