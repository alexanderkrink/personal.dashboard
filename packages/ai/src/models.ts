/**
 * Model tiers decouple call sites from concrete model IDs.
 *
 * Pick a tier by job, not by habit:
 * - fast:     high-volume, low-stakes extraction/classification (flashcard drafts, tagging)
 * - balanced: default for content generation (topic pages, lessons, feedback)
 * - deep:     rare, high-stakes synthesis (exam review generation, study plan reasoning)
 */
export const MODELS = {
  fast: "claude-haiku-4-5",
  balanced: "claude-sonnet-5",
  deep: "claude-opus-4-8",
} as const satisfies Record<string, string>;

export type ModelTier = keyof typeof MODELS;

export type ModelId = (typeof MODELS)[ModelTier];
