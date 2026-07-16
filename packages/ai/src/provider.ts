import { createAnthropic } from "@ai-sdk/anthropic";
import { MODELS, type ModelTier } from "./models";

export type AIProvider = ReturnType<typeof createAnthropic>;

/**
 * Creates the Anthropic provider. This package never reads process.env —
 * the calling app injects configuration (see apps/web/src/env.ts).
 */
export function createAIProvider(options: { apiKey: string }): AIProvider {
  return createAnthropic({ apiKey: options.apiKey });
}

/** Resolves a model tier to a concrete AI SDK language model. */
export function getModel(provider: AIProvider, tier: ModelTier) {
  return provider(MODELS[tier]);
}
