/**
 * `@study/ai` — ALL LLM interaction for the Study Dashboard.
 *
 * Providers, the model-per-job registry, prompt templates, structured-output schemas, the
 * failure ladder and the per-provider price tables. No `@ai-sdk/*` import and no model ID
 * appears anywhere else in the repo, and this package never reads `process.env` — the app
 * injects configuration (`apps/web/src/env.ts`).
 *
 * Start at `createAIRuntime`. See PLAN.md §AI Strategy.
 */

export {
  AI_PAUSED_USER_MESSAGE,
  AIPausedError,
  type AISpendGuardConfig,
  type CallKind,
  type GuardDecision,
  guardDecision,
  type PausedReason,
  SPEND_THRESHOLDS,
  type SpendPosture,
  spendPosture,
} from "./guard";
export {
  type AttemptRecord,
  type AttemptRequest,
  type AttemptResult,
  correctiveMessage,
  type DeadLetterReason,
  type LadderOptions,
  type LadderResult,
  type LadderStep,
  runStructuredLadder,
} from "./ladder";
export {
  escalationTarget,
  getModel,
  JOB_IDS,
  JOBS,
  type JobId,
  MODEL_IDS,
  MODELS,
  type ModelId,
  type ModelResolution,
  type ProviderName,
  RANK,
  type Rank,
} from "./models";
export {
  EMBEDDING_PRICING,
  type IntroductoryPricing,
  type ModelPricing,
  PRICING,
  type PriceOptions,
  priceUsd,
  ratesFor,
  type TokenRates,
  type TokenUsage,
} from "./pricing";
export {
  type AnyPromptTemplate,
  assertPromptId,
  definePrompt,
  jobForPromptId,
  PROMPT_REGISTRY,
  type PromptId,
  type PromptTemplate,
  type PromptVars,
  type PromptVarValue,
  promptIdViolation,
} from "./prompts/index";
/**
 * Types only. `createAIProvider` and `languageModelFor` are deliberately NOT re-exported:
 * they hand back a raw SDK model with no stamp, no metering and no kill switch, and an
 * importable factory is a bypass that no amount of naming discipline inside
 * `generateStructured` can prevent. `createAIRuntime` is the only way in — and the two
 * acknowledged escapes on it (`unmeteredLanguageModel`, `unmeteredProviders`) at least
 * come from a runtime that has a logger and a guard attached.
 *
 * They stay exported from `./provider` for this package's own use and its tests.
 */
export type { AIProviderConfig, AIProviders } from "./provider";
export {
  type AIGenerationLogger,
  type AIGenerationRecord,
  type AIGenerationStamp,
  type AIRuntime,
  type AIRuntimeConfig,
  createAIRuntime,
  type GenerateStructuredOptions,
  type GenerateStructuredResult,
  sha256Hex,
  UNMETERED_ACKNOWLEDGEMENT,
  type UnmeteredAcknowledgement,
} from "./runtime";
export * from "./schemas/index";
