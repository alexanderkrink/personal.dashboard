export {
  type DiffStatus,
  diffCountLabel,
  diffTopicPages,
  type TopicPageDiff,
  type TopicPageDiffEntry,
} from "./diff";
export {
  applyDuplicateGuard,
  type CoercionReason,
  cosineSimilarity,
  DUPLICATE_TITLE_THRESHOLD,
  type DuplicateCoercion,
  type DuplicateGuardResult,
  type ExistingTopicTitle,
  type RoutedSegment,
  type RoutingProposal,
  type UnguardedProposal,
} from "./duplicate-guard";
export {
  detectSingleTopicFunnel,
  FUNNEL_MIN_SEGMENTS,
  type FunnelBackstopInput,
} from "./funnel-guard";
export {
  detectUngroundedContent,
  type ExpansionMeasurement,
  type GroundingFinding,
  type GroundingFindingKind,
  MAX_EXPANSION_RATIO,
  measureExpansion,
} from "./grounding";
export {
  type DeclaredRemoval,
  detectMergeLoss,
  type LossDetectorInput,
  type LossDetectorResult,
  type LossFinding,
  type LossFindingKind,
  type LossSeverity,
} from "./loss-detector";
export {
  computeDocumentOutcome,
  type DocumentOutcome,
  type DocumentOutcomeInput,
  type DocumentOutcomeStatus,
  type FailedTopic,
  outcomeMessage,
  type TopicMergeOutcome,
} from "./outcome";
export {
  type BlockKind,
  type BlockSourceLike,
  type DiffBlock,
  type FormulaLike,
  flattenTopicPage,
  identityKey,
  type KeyTermLike,
  type LocatorLike,
  locatorUnit,
  type NoteBlockLike,
  type OpenQuestionLike,
  type TopicPageLike,
  type WorkedExampleLike,
} from "./page";
export {
  analyseProvenance,
  type CitationCollapse,
  type CitationStatus,
  COLLAPSE_MIN_CITATIONS,
  COLLAPSE_MIN_PAGES_AVAILABLE,
  type ProvenanceBlock,
  type ProvenanceCitation,
  type ProvenanceDocumentLike,
  type ProvenanceInput,
  type ProvenanceReport,
  type ProvenanceStrength,
} from "./provenance";
export {
  type MergePlan,
  type MergeTargetLike,
  type PlanMergeWorkInput,
  type PriorContribution,
  planMergeWork,
  type SkippedTarget,
} from "./reprocess";
export {
  type BatchLocalAssign,
  isAssignDecision,
  isCreateDecision,
  type ResolvedProposal,
  type RoutableSegmentLike,
  type RoutingDecisionLike,
  type RoutingResolution,
  resolveRoutingDecisions,
  type UnresolvableAssign,
} from "./route-decisions";
export {
  type ExtractedHeadingLike,
  type ExtractedPageLike,
  type Segment,
  type SegmentationInput,
  type SegmentationResult,
  type SkippedRangeLike,
  segmentExtraction,
} from "./segment";
export {
  type DocumentStripPlan,
  type PageStripResult,
  planDocumentStrip,
  type StripBlockKind,
  type StripCounts,
  stripDocumentFromPage,
  type TopicStripTargetLike,
  type TopicStripVerdict,
} from "./strip";
