/**
 * Structured-output schemas (PLAN.md §AI Strategy §2).
 *
 * **One file per feature area** in this directory — `documents.ts`, `flashcards.ts`,
 * `syllabus.ts`, … — each re-exported from here and from the package index, so callers
 * import the schema *and* its inferred type from `@study/ai`. The schema is the single
 * source of truth for both the model contract and the TypeScript type.
 *
 * Design constraints for anything added here:
 * - Keep schemas flat-ish and non-recursive.
 * - `.describe()` every field — descriptions are prompt surface, not documentation.
 * - Don't reach for numeric/string min-max to *constrain generation*; the AI SDK strips
 *   JSON Schema keywords the provider can't enforce. `z.string().min(1)` is still worth
 *   writing — it just means client-side validation, which is what trips the §2 failure
 *   ladder, not a generation-time guarantee.
 * - Boundary rule regardless of source: anything read back *out* of the DB that claims to
 *   be a schema type gets `safeParse`d before use. Schemas evolve, stored artifacts don't.
 *
 * The M0 placeholder (`documentSummarySchema`) was retired rather than moved into
 * `documents.ts`: it had no prompt and no job behind it, and a plausible-looking
 * `documents.ts` would have read as the real document-pipeline contract to Wave 4 instead
 * of as a stub. `syllabus.ts` (M1 item 11) is the first real feature area.
 */

export {
  AUDIT_VERDICTS,
  type AuditFinding,
  auditFindingSchema,
  type CoverageChecklist,
  coverageChecklistSchema,
  type DeepReviewAudit,
  deepReviewAuditSchema,
  OBJECTIVE_COVERAGE,
  type ObjectiveCoverage,
  objectiveCoverageSchema,
} from "./coverage";
export {
  type DocumentExtraction,
  documentExtractionSchema,
  EXTRACTION_FIDELITIES,
  EXTRACTION_ROUTES,
  type ExamSignal,
  type ExtractedDefinition,
  type ExtractedExample,
  type ExtractedFormula,
  type ExtractedHeading,
  type ExtractedPage,
  type ExtractionFidelity,
  type ExtractionRoute,
  examSignalSchema,
  extractedDefinitionSchema,
  extractedExampleSchema,
  extractedFormulaSchema,
  extractedHeadingSchema,
  extractedPageSchema,
  extractionFidelitySchema,
  extractionRouteSchema,
  fidelityForRoute,
  type SkippedRange,
  type StoredExtraction,
  skippedRangeSchema,
  storedExtractionSchema,
} from "./documents";
export {
  EXAM_QUESTION_KINDS,
  EXAM_SECTION_DEPTH,
  type ExamFormulaEntry,
  type ExamQuestion,
  type ExamReview,
  type ExamTopicSection,
  type ExamWeakSpot,
  examFormulaEntrySchema,
  examQuestionSchema,
  examReviewSchema,
  examTopicSectionSchema,
  examWeakSpotSchema,
} from "./exam-review";
export {
  QUICK_ADD_KINDS,
  type QuickAddParse,
  quickAddParseSchema,
} from "./quick-add";
export {
  ASSESSMENT_KINDS,
  assessmentKindSchema,
  type SyllabusComponent,
  type SyllabusComponents,
  syllabusComponentSchema,
  syllabusComponentsSchema,
} from "./syllabus";
export {
  type BlockRemoval,
  type BlockSource,
  blockRemovalSchema,
  blockSourceSchema,
  CRITIC_ISSUE_KINDS,
  CRITIC_SEVERITIES,
  type CriticIssue,
  criticIssueSchema,
  EMPTY_TOPIC_PAGE,
  type KeyTerm,
  keyTermSchema,
  type MergeCriticVerdict,
  mergeCriticSchema,
  type NoteBlock,
  noteBlockSchema,
  OPEN_QUESTION_KINDS,
  type OpenQuestion,
  openQuestionSchema,
  type RoutingBatch,
  type RoutingDecision,
  routingBatchSchema,
  routingDecisionSchema,
  type StoredTopicPage,
  storedTopicPageSchema,
  type TopicFormula,
  type TopicMerge,
  type TopicPage,
  type TopicWorkedExample,
  topicFormulaSchema,
  topicMergeSchema,
  topicPageSchema,
  topicWorkedExampleSchema,
} from "./topics";
