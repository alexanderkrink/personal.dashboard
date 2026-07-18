/**
 * The pure calendar core — PLAN "Deadlines & Calendar Hub".
 *
 * Parsing lives here; fetching does not. The I/O shell (conditional GET, body
 * hashing, persistence) is `apps/web/src/server/calendar/`.
 */

export {
  type AssessmentOracleRow,
  type DetectExamInput,
  detectExam,
  type ExamCandidateEvent,
  type ExamDetection,
  type ExamDetectionSource,
  type ExamFlags,
  maxSessionNumber,
  type RetakeEvent,
  type SemesterBounds,
} from "./exam-detection";
export { type ClassifyKindInput, classifyKind } from "./kind";
export {
  type ParseIcsOptions,
  type ParseIcsResult,
  parseIcsToNormalizedEvents,
} from "./parse-ics";
export {
  daysUntil,
  HIGH_WEIGHT_THRESHOLD,
  KIND_DEFAULT_WEIGHT,
  MEDIUM_WEIGHT_THRESHOLD,
  MIN_DAYS_UNTIL_DUE,
  type PriorityTier,
  priorityScore,
  priorityTier,
  type RankableItem,
  type RankedItem,
  type ResolvedWeight,
  rankItems,
  resolveWeightPercent,
  type WeightResolutionInput,
} from "./priority";
export type {
  CalendarItemKind,
  CalendarProvider,
  CalendarSource,
  NormalizedEvent,
  NormalizedOccurrence,
  OccurrenceStatus,
  SyncError,
  SyncInput,
  SyncOutput,
} from "./provider";
export {
  classifyPseudoRow,
  expandSessionRange,
  type NormalizedSummary,
  type NormalizeSummaryOptions,
  normalizeSummary,
  occurrenceLabel,
  type PseudoRow,
  type PseudoRowReason,
  type SessionDescriptor,
  stripJunk,
} from "./summary";
export {
  isKnownTimezone,
  timezoneOffsetMs,
  UnknownTimezoneError,
  type WallClock,
  wallClockAt,
  wallClockToUtcIso,
  wallClockToUtcMs,
} from "./timezone";
export { HORIZON_DAYS, type WeekWindow, weekWindow } from "./week";
