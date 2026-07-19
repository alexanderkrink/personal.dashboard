/**
 * The two completeness calls — the syllabus checklist and the Step D audit (M1 item 5e).
 *
 * Like `topic-pipeline`, this module is the binding of prompt → schema → job and nothing
 * else. It knows nothing about Supabase, Inngest, or where the text came from, so the
 * model-pairing decisions that matter are expressed once here rather than re-decided at
 * every call site.
 *
 * Both calls go through `runtime.generateStructured`: the §3 stamp, the §2 ladder, the §6
 * guard and metering come from there and none of them is bypassable.
 */

import {
  COVERAGE_CHECKLIST_SYSTEM,
  coverageChecklistPrompt,
  DEEP_REVIEW_AUDIT_SYSTEM,
  deepReviewAuditPrompt,
} from "../prompts/coverage";
import type { AIRuntime, GenerateStructuredResult } from "../runtime";
import {
  type CoverageChecklist,
  coverageChecklistSchema,
  type DeepReviewAudit,
  deepReviewAuditSchema,
} from "../schemas/coverage";

/** One entry of the topic index these calls check against. Mirrors `TopicIndexEntry`. */
export interface CompletenessTopic {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly keyTerms: readonly string[];
}

/**
 * Renders the topic index both calls read.
 *
 * Sorted by title rather than by id or recency, for the reason `renderTopicIndex` gives: any
 * ordering derived from row creation or update time reshuffles the prompt prefix on every
 * merge and throws away the cache. Kept separate from `renderTopicIndex` because these calls
 * need the summary in full — the checklist decides "does a page teach this?" from it, and
 * truncating it to fit a cache prefix would make that decision on less evidence than the
 * cheaper routing call gets.
 */
export function renderCompletenessIndex(topics: readonly CompletenessTopic[]): string {
  if (topics.length === 0) {
    return "(This course has no topic pages yet — nothing has been covered.)";
  }
  return [...topics]
    .sort((a, b) => a.title.localeCompare(b.title))
    .map(
      (topic) =>
        `- id: ${topic.id}\n  title: ${topic.title}\n  summary: ${topic.summary}\n  key terms: ${
          topic.keyTerms.length === 0 ? "(none recorded)" : topic.keyTerms.join(", ")
        }`,
    )
    .join("\n");
}

export interface CheckSyllabusCoverageOptions {
  readonly runtime: AIRuntime;
  readonly courseTitle: string;
  readonly topics: readonly CompletenessTopic[];
  /** The syllabus document's extracted text. The whole body — see `prompts/syllabus.ts`. */
  readonly syllabusText: string;
}

/**
 * §5's importance oracle.
 *
 * `kind: "background"` because nobody is sitting on a screen waiting for it — the document
 * has already produced its topic pages by the time this runs, and under budget pressure §6
 * is right to shed this before it sheds anything interactive.
 */
export function checkSyllabusCoverage({
  runtime,
  courseTitle,
  topics,
  syllabusText,
}: CheckSyllabusCoverageOptions): Promise<GenerateStructuredResult<CoverageChecklist>> {
  return runtime.generateStructured({
    prompt: coverageChecklistPrompt,
    vars: {
      courseTitle,
      topicIndex: renderCompletenessIndex(topics),
      syllabusText,
    },
    schema: coverageChecklistSchema,
    system: COVERAGE_CHECKLIST_SYSTEM,
    kind: "background",
  });
}

export interface AuditDocumentOptions {
  readonly runtime: AIRuntime;
  readonly courseTitle: string;
  readonly documentLabel: string;
  readonly sessionLabel: string | null;
  readonly topics: readonly CompletenessTopic[];
  /** The document's material as text — the extraction's pages, rendered with locators. */
  readonly material: string;
}

/**
 * §5 Step D.
 *
 * ⚠ Pinned to `claude-opus-4-8`, a **different family from the `gemini-3.1-pro-preview`
 * extractor whose work it audits**. That is the property the whole step is bought for; see
 * the long note on `deepReviewAuditPrompt`. Re-pointing this job onto Google does not make
 * the audit cheaper, it makes it a second opinion from the model that already gave the
 * first one.
 */
export function auditDocument({
  runtime,
  courseTitle,
  documentLabel,
  sessionLabel,
  topics,
  material,
}: AuditDocumentOptions): Promise<GenerateStructuredResult<DeepReviewAudit>> {
  return runtime.generateStructured({
    prompt: deepReviewAuditPrompt,
    vars: {
      courseTitle,
      documentLabel,
      sessionLabel: sessionLabel ?? "",
      topicIndex: renderCompletenessIndex(topics),
      material,
    },
    schema: deepReviewAuditSchema,
    system: DEEP_REVIEW_AUDIT_SYSTEM,
    kind: "background",
  });
}
