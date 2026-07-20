import { type StoredTopicPage, storedTopicPageSchema } from "@study/ai";
import { analyseProvenance, type ProvenanceDocumentLike, type ProvenanceReport } from "@study/core";
import { z } from "zod";
import { coverageSchema, type DocumentCoverage } from "@/lib/documents/coverage";

/**
 * Turning the four rows behind a topic page into the one object the UI renders.
 *
 * Everything here is a **pure function over already-fetched rows**. The page component
 * fetches; this module decides what the fetched thing means. That split is what makes the
 * grounding affordances testable against the frozen Wave 4 corpus — a React Server
 * Component that awaited Supabase could not be pointed at a JSON fixture, and an affordance
 * that cannot be aimed at the artifact it exists to catch is an affordance nobody has
 * checked.
 *
 * The boundary rule applies in full: `topics.page`, `documents.coverage` and
 * `documents.extraction` are all `jsonb` written by earlier versions of this code and by
 * models, so every one of them is `safeParse`d on the way out of the database rather than
 * cast.
 */

/* ────────────────────────────────────────────────────────────────────────── */
/* Row shapes                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

export const topicRowSchema = z.object({
  id: z.uuid(),
  course_id: z.uuid(),
  title: z.string(),
  slug: z.string(),
  summary: z.string(),
  page: z.unknown(),
  exam_weight: z.number(),
  exam_weight_override: z.number().nullable(),
  revision: z.number(),
  updated_at: z.string(),
});

export type TopicRow = z.infer<typeof topicRowSchema>;

export const topicDocumentRowSchema = z.object({
  id: z.uuid(),
  filename: z.string(),
  session_label: z.string().nullable(),
  kind: z.string(),
  status: z.string(),
  extraction_fidelity: z.string().nullable(),
  failure_reason: z.string().nullable(),
  coverage: z.unknown(),
  extraction: z.unknown(),
  failed_topics: z.unknown(),
  created_at: z.string(),
});

export type TopicDocumentRow = z.infer<typeof topicDocumentRowSchema>;

export const topicRevisionRowSchema = z.object({
  id: z.uuid(),
  revision: z.number(),
  page: z.unknown(),
  change_summary: z.string(),
  source: z.string(),
  needs_review: z.boolean(),
  document_id: z.uuid().nullable(),
  prompt_id: z.string(),
  prompt_version: z.number(),
  model: z.string(),
  created_at: z.string(),
});

export type TopicRevisionRow = z.infer<typeof topicRevisionRowSchema>;

/**
 * Just enough of `documents.extraction` to know which pages were read.
 *
 * The column holds an envelope (`{extraction: {...}, route, fidelity, …}`), and only
 * `extraction.pages[].page` is needed here. Parsing loosely and defaulting to `[]` is
 * deliberate: "we do not know which pages were read" and "no pages were read" must not
 * collapse into the same value, and {@link analyseProvenance} treats an empty list as the
 * former. See its `pagesRead` note.
 */
const extractionEnvelopeSchema = z.object({
  extraction: z
    .object({
      pages: z.array(z.object({ page: z.number(), title: z.string().default("") })).default([]),
    })
    .default({ pages: [] }),
});

/* ────────────────────────────────────────────────────────────────────────── */
/* View model                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

export interface TopicDocumentView {
  readonly id: string;
  /** `session_label` when the user gave one, else the filename. What a chip shows. */
  readonly label: string;
  readonly filename: string;
  readonly status: string;
  readonly extractionFidelity: string | null;
  readonly failureReason: string | null;
  readonly coverage: DocumentCoverage | null;
  readonly pagesRead: readonly number[];
  /** Page → its extracted heading, so a chip can name what is actually on the page. */
  readonly pageTitles: ReadonlyMap<number, string>;
  /** Set on `partial`: topics this document failed to merge into. */
  readonly failedTopicCount: number;
}

export interface TopicRevisionView {
  readonly id: string;
  readonly revision: number;
  readonly page: StoredTopicPage;
  readonly changeSummary: string;
  readonly source: string;
  readonly needsReview: boolean;
  readonly documentId: string | null;
  readonly documentLabel: string | null;
  readonly promptId: string;
  readonly promptVersion: number;
  readonly model: string;
  readonly createdAt: string;
  /** The §8 drawer label — "Lecture 7 expanded this page". */
  readonly headline: string;
}

export interface TopicView {
  readonly id: string;
  readonly courseId: string;
  readonly title: string;
  readonly slug: string;
  readonly summary: string;
  readonly page: StoredTopicPage;
  readonly examWeight: number;
  readonly examWeightOverride: number | null;
  readonly revision: number;
  readonly updatedAt: string;
  readonly documents: readonly TopicDocumentView[];
  readonly revisions: readonly TopicRevisionView[];
  readonly provenance: ProvenanceReport;
  /**
   * True when this topic has never had a revision row written for it.
   *
   * 🔴 Verified live 2026-07-20: the merge **create** path in
   * `apps/web/src/inngest/route-and-merge.ts` inserts the topic with `revision: 1` and does
   * NOT insert a `topic_revisions` row — only the update path does. So every topic still on
   * its first version has an empty history, and the drawer must say so in words rather than
   * render an empty list, which reads as "nothing happened" for a page that was in fact
   * wholly generated by a model.
   */
  readonly historyMissingForFirstVersion: boolean;
  /** Latest revision's `needs_review`. Null when there is no revision to ask. */
  readonly needsReview: boolean | null;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Assembly                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/** Parses `topics.page` / `topic_revisions.page`, falling back to the empty page. */
export function parseStoredPage(value: unknown): StoredTopicPage {
  const parsed = storedTopicPageSchema.safeParse(value ?? {});
  return parsed.success
    ? parsed.data
    : { summary: "", notes: [], keyTerms: [], formulas: [], workedExamples: [], openQuestions: [] };
}

export function toDocumentView(row: TopicDocumentRow): TopicDocumentView {
  const coverage = coverageSchema.safeParse(row.coverage);
  const extraction = extractionEnvelopeSchema.safeParse(row.extraction);
  const pages = extraction.success ? extraction.data.extraction.pages : [];
  const failedTopics = z.array(z.unknown()).safeParse(row.failed_topics);

  return {
    id: row.id,
    label: (row.session_label ?? "").trim() === "" ? row.filename : (row.session_label as string),
    filename: row.filename,
    status: row.status,
    extractionFidelity: row.extraction_fidelity,
    failureReason: row.failure_reason,
    coverage: coverage.success ? coverage.data : null,
    pagesRead: pages.map((p) => p.page),
    pageTitles: new Map(pages.map((p) => [p.page, p.title])),
    failedTopicCount: failedTopics.success ? failedTopics.data.length : 0,
  };
}

/**
 * The §8 drawer label for one revision.
 *
 * "⚠ flagged — review this change" wins over the source label, because a student scanning
 * the list needs the flag to be the thing they see, not a suffix on a sentence about
 * lecture 7.
 */
export function revisionHeadline(input: {
  readonly source: string;
  readonly needsReview: boolean;
  readonly documentLabel: string | null;
}): string {
  if (input.needsReview) return "⚠ Flagged — review this change";
  if (input.source === "revert") return "Reverted to an earlier version";
  if (input.source === "deep_review") return "Deep review added to this page";
  if (input.documentLabel !== null) return `${input.documentLabel} expanded this page`;
  return "A merge expanded this page";
}

export function toRevisionView(
  row: TopicRevisionRow,
  documents: ReadonlyMap<string, TopicDocumentView>,
): TopicRevisionView {
  const documentLabel =
    row.document_id === null ? null : (documents.get(row.document_id)?.label ?? null);
  return {
    id: row.id,
    revision: row.revision,
    page: parseStoredPage(row.page),
    changeSummary: row.change_summary,
    source: row.source,
    needsReview: row.needs_review,
    documentId: row.document_id,
    documentLabel,
    promptId: row.prompt_id,
    promptVersion: row.prompt_version,
    model: row.model,
    createdAt: row.created_at,
    headline: revisionHeadline({
      source: row.source,
      needsReview: row.needs_review,
      documentLabel,
    }),
  };
}

/**
 * Builds the whole view model. Pure — hand it rows, get back what the page renders.
 */
export function buildTopicView(input: {
  readonly topic: TopicRow;
  readonly documents: readonly TopicDocumentRow[];
  readonly revisions: readonly TopicRevisionRow[];
}): TopicView {
  const documents = input.documents.map(toDocumentView);
  const byId = new Map(documents.map((d) => [d.id, d]));
  const page = parseStoredPage(input.topic.page);

  const revisions = input.revisions
    .map((row) => toRevisionView(row, byId))
    .sort((a, b) => b.revision - a.revision);

  const provenanceDocuments: ProvenanceDocumentLike[] = documents.map((d) => ({
    id: d.id,
    label: d.label,
    pagesRead: d.pagesRead,
  }));

  const latest = revisions[0];

  return {
    id: input.topic.id,
    courseId: input.topic.course_id,
    title: input.topic.title,
    slug: input.topic.slug,
    summary: input.topic.summary,
    page,
    examWeight: input.topic.exam_weight,
    examWeightOverride: input.topic.exam_weight_override,
    revision: input.topic.revision,
    updatedAt: input.topic.updated_at,
    documents,
    revisions,
    provenance: analyseProvenance({ page, documents: provenanceDocuments }),
    historyMissingForFirstVersion: revisions.length === 0,
    needsReview: latest === undefined ? null : latest.needsReview,
  };
}

/**
 * The coverage a topic page should show, and which document it belongs to.
 *
 * A topic can be fed by several documents, each with its own coverage map, so there is no
 * single "this topic's coverage" number. Showing them per document is the only honest
 * shape — and the one that makes "this deck contributed 1 of its 54 pages" legible, which
 * is the sentence Wave 4 never printed.
 */
export function coverageEntries(
  view: TopicView,
): readonly { document: TopicDocumentView; coverage: DocumentCoverage }[] {
  return view.documents.flatMap((document) =>
    document.coverage === null ? [] : [{ document, coverage: document.coverage }],
  );
}
