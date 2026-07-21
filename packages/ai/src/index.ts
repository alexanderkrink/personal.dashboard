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
  createEmbeddingClient,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDING_PURPOSES,
  EMBEDDING_RECIPE_VERSION,
  type EmbeddingClient,
  type EmbeddingClientConfig,
  type EmbeddingGenerationRecord,
  type EmbeddingInputType,
  type EmbeddingLogger,
  type EmbeddingPurpose,
  EmbeddingsPausedError,
  type EmbedOptions,
  type EmbedResult,
  type FetchLike,
  type FetchRequestInit,
  type FetchResponse,
  VoyageEmbeddingError,
} from "./embeddings";
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
  type SpendReading,
  spendPosture,
  UNPRICED_TOLERANCE,
} from "./guard";
export {
  type AuditDocumentOptions,
  auditDocument,
  type CheckSyllabusCoverageOptions,
  type CompletenessTopic,
  checkSyllabusCoverage,
  renderCompletenessIndex,
} from "./jobs/completeness";
export {
  PDF_MEDIA_TYPE,
  type StructurePdfOptions,
  type StructureSlideTextOptions,
  structurePdf,
  structureSlideText,
} from "./jobs/doc-structuring";
export {
  type ParseQuickAddOptions,
  parseQuickAdd,
  type QuickAddCourse,
  renderQuickAddCourses,
} from "./jobs/quick-add";
export {
  type ExtractSyllabusComponentsOptions,
  extractSyllabusComponents,
} from "./jobs/syllabus-components";
export {
  type CriticiseMergeOptions,
  criticiseMerge,
  type MergeTopicOptions,
  mergeTopic,
  type RemergeTopicOptions,
  type RoutableSegment,
  type RouteSegmentsOptions,
  remergeTopic,
  renderMergeSegments,
  renderRoutableSegments,
  renderTopicIndex,
  routeSegments,
  type TopicIndexEntry,
} from "./jobs/topic-pipeline";
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
  AI_PROVIDER_NAMES,
  type AIProviderName,
  type EmbeddingProviderName,
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
  type EmbeddingModelId,
  embeddingPriceUsd,
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
  COVERAGE_CHECKLIST_SYSTEM,
  coverageChecklistPrompt,
  DEEP_REVIEW_AUDIT_SYSTEM,
  deepReviewAuditPrompt,
} from "./prompts/coverage";
export { EXAM_REVIEW_SYSTEM, examReviewPrompt } from "./prompts/exam-review";
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
export { QUICK_ADD_SYSTEM, quickAddPrompt } from "./prompts/quick-add";
export {
  MERGE_CRITIC_SYSTEM,
  mergeCriticPrompt,
  TOPIC_MERGE_SYSTEM,
  TOPIC_ROUTING_SYSTEM,
  topicMergePrompt,
  topicMergeRepairPrompt,
  topicRoutingPrompt,
} from "./prompts/topics";
/**
 * Types only. `createAIProvider` and `languageModelFor` are deliberately NOT re-exported:
 * they hand back a raw SDK model with no stamp, no metering and no kill switch, and an
 * importable factory is a bypass that no amount of naming discipline inside
 * `generateStructured` can prevent. `createAIRuntime` is the only way in.
 *
 * As of Wave 5 there is no acknowledged escape either: `unmeteredLanguageModel`,
 * `unmeteredProviders` and `UNMETERED_ACKNOWLEDGEMENT` are gone, replaced by the metered
 * `AIRuntime.streamProse`. Every route out of this package now writes an `ai_generations`
 * row.
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
  type GenerationOutcome,
  type PromptFile,
  type StreamProseOptions,
  schemaHashHex,
  sha256Hex,
  sha256HexBytes,
} from "./runtime";
export * from "./schemas/index";
