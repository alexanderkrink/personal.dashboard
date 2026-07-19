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
  type ExtractedHeadingLike,
  type ExtractedPageLike,
  type Segment,
  type SegmentationInput,
  type SegmentationResult,
  type SkippedRangeLike,
  segmentExtraction,
} from "./segment";
