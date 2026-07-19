/**
 * Steps A, B, B2 and C of the merge algorithm (PLAN §5, M1 item 5d).
 *
 * This is the heart of the product invariant: **a course's topic set is a stable, growing
 * index — documents contribute to it; they never own pages.** Uploading session 7's slides
 * expands and refines the existing topic pages; it never creates a "Lecture 7 notes" silo.
 *
 * Four things happen here, and the ordering between them is the design:
 *
 * | Step | What | Where the logic lives |
 * | --- | --- | --- |
 * | A | segment → embed → retrieve top-5 → one batched routing call → duplicate guard | `@study/core` + `topic-routing` |
 * | B | one merge call per affected topic | `topic-merge` (Sonnet) |
 * | B2 | deterministic loss-detector, then a cross-family critic, then at most one re-merge | `@study/core` + `merge-critic` (Gemini) |
 * | C | per-topic persist: revision snapshot, page update, re-embed, `topic_sources` upsert | here |
 *
 * ## Why the per-topic work is isolated
 *
 * PLAN §7 makes partial success a first-class outcome: one failed merge must not doom the
 * document. So {@link mergeTopics} catches per-topic failures rather than letting them
 * propagate, and hands the caller a list that `finalize` turns into `ready` / `partial` /
 * `failed` plus the `failed_topics` retry set. A thrown error here would take a document
 * that successfully merged nine topics and mark the whole thing failed.
 *
 * ## Why the revision counter is a plain increment
 *
 * `process-document` carries `concurrency: [{ key: "event.data.courseId", limit: 1 }]`, and
 * that was measured rather than assumed — two same-course runs serialized 1.48 s apart
 * instead of running in parallel. Course-level serialization is what makes read-then-write
 * on `topics.revision` safe, so there is deliberately no distributed-locking machinery
 * here. If that concurrency key is ever removed, this becomes a lost-update bug.
 */

import type { EmbeddingClient, RoutableSegment, StoredTopicPage, TopicMerge } from "@study/ai";
import {
  criticiseMerge,
  EMPTY_TOPIC_PAGE,
  mergeTopic,
  remergeTopic,
  routeSegments,
  storedExtractionSchema,
  storedTopicPageSchema,
} from "@study/ai";
import {
  applyDuplicateGuard,
  computeDocumentOutcome,
  cosineSimilarity,
  type DocumentOutcome,
  type DuplicateCoercion,
  detectMergeLoss,
  type ExistingTopicTitle,
  flattenTopicPage,
  type LossFinding,
  type RoutedSegment,
  type RoutingProposal,
  type Segment,
  segmentExtraction,
  type TopicMergeOutcome,
} from "@study/core";
import type { SupabaseAdminClient } from "@study/db";
import { logProcessingEvent, setDocumentStatus } from "@/inngest/documents";
import { createStudyEmbeddingClient, parseStoredVector, toStoredVector } from "@/lib/ai/embeddings";
import { createStudyAIRuntime } from "@/lib/ai/runtime";

/** How many existing topics the routing call sees as candidates per segment (§5 Step A.2). */
const CANDIDATES_PER_SEGMENT = 5;

/** Key terms shown per topic in the cached index. Enough to disambiguate, few enough to cache. */
const INDEX_KEY_TERMS = 6;

export interface RouteAndMergeInput {
  readonly admin: SupabaseAdminClient;
  readonly userId: string;
  readonly documentId: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly filename: string;
  readonly sessionLabel: string | null;
}

export interface RouteAndMergeSummary {
  readonly outcome: DocumentOutcome;
  /**
   * The per-topic results the outcome was computed from.
   *
   * Carried so `finalize` can **recompute** the outcome after the steps below this one have
   * run: PLAN §7 puts an embedding failure on the `partial` path, and that is not known
   * until chunk-and-embed has finished. Recomputing from the same inputs plus a `degraded`
   * flag beats patching the status by hand, which is how `ready` and `partial` drift apart.
   */
  readonly topicOutcomes: readonly TopicMergeOutcome[];
  readonly segments: number;
  readonly topicsTouched: number;
  readonly topicsCreated: number;
  readonly coercions: number;
  readonly unaccountedPages: number;
  readonly costUsd: number | null;
  readonly elapsedMs: number;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Loading the course's existing index                                        */
/* ────────────────────────────────────────────────────────────────────────── */

interface ExistingTopic {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly revision: number;
  readonly page: StoredTopicPage;
  readonly titleEmbedding: number[] | null;
  readonly summaryEmbedding: number[] | null;
}

/**
 * Loads every topic of the course.
 *
 * The whole set, not a shortlist: §5 Step A.1's cached prefix IS the full index, and the
 * duplicate guard needs every title vector to be able to say a proposed title is novel. A
 * course is a few dozen topics at most, so this is one cheap query rather than a scaling
 * concern.
 *
 * ⚠ Retrieval is done **in this process**, not by `match_chunks` or any other pgvector
 * query. That is deliberate: Wave 4 measured that a `course_id` filter applies *after* the
 * ANN scan rather than before it, which silently returned zero rows. At this cardinality an
 * exact cosine over a few dozen vectors is both correct and faster than an index probe, and
 * it has no filter-ordering trap to fall into.
 */
async function loadCourseTopics(
  admin: SupabaseAdminClient,
  userId: string,
  courseId: string,
): Promise<readonly ExistingTopic[]> {
  const { data, error } = await admin
    .from("topics")
    .select("id, title, summary, revision, page, title_embedding, summary_embedding")
    .eq("user_id", userId)
    .eq("course_id", courseId);

  if (error) throw new Error(`Could not load topics for course ${courseId}: ${error.message}`);

  return (data ?? []).map((row) => {
    // Boundary rule: a stored page is an external input to every future version of this
    // code. `storedTopicPageSchema` defaults every field, so a bare `{}` — which is what
    // `topics.page`'s column default holds — parses into an empty page rather than failing.
    const parsedPage = storedTopicPageSchema.safeParse(row.page);
    return {
      id: row.id,
      title: row.title,
      summary: row.summary,
      revision: row.revision,
      page: parsedPage.success ? parsedPage.data : EMPTY_TOPIC_PAGE,
      titleEmbedding: parseStoredVector(row.title_embedding),
      summaryEmbedding: parseStoredVector(row.summary_embedding),
    };
  });
}

/** `Neural Networks` → `neural-networks`, uniquified against the course's taken slugs. */
function slugFor(title: string, taken: ReadonlySet<string>): string {
  const base =
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "topic";

  if (!taken.has(base)) return base;
  for (let n = 2; n < 500; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // `unique (course_id, slug)` would reject a duplicate anyway; a random tail is a better
  // failure than a loop that gives up and returns a slug it knows is taken.
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Step A — segment & route                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

interface RoutingOutcome {
  readonly segments: readonly Segment[];
  readonly routed: readonly RoutedSegment[];
  readonly coercions: readonly DuplicateCoercion[];
  readonly unaccountedPages: readonly number[];
  readonly coverageChecked: boolean;
}

export async function runRouting(input: {
  readonly admin: SupabaseAdminClient;
  readonly userId: string;
  readonly documentId: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly filename: string;
  readonly sessionLabel: string | null;
  readonly existingTopics: readonly ExistingTopic[];
  readonly embeddings: EmbeddingClient;
  readonly runtime: ReturnType<typeof createStudyAIRuntime>;
}): Promise<RoutingOutcome> {
  const { admin, userId, documentId, courseId } = input;

  // ── Read the extraction back, through the schema and never through a cast ──
  const { data: row, error } = await admin
    .from("documents")
    .select("extraction")
    .eq("id", documentId)
    .eq("user_id", userId)
    .single();

  if (error) throw new Error(`Could not read the extraction for ${documentId}: ${error.message}`);

  const parsed = storedExtractionSchema.safeParse(row.extraction);
  if (!parsed.success) {
    throw new Error(
      `documents.extraction for ${documentId} did not match storedExtractionSchema: ${parsed.error.message}`,
    );
  }
  const stored = parsed.data;

  // ── A.2: split along the document's own structure ─────────────────────────
  const segmentation = segmentExtraction({
    pages: stored.extraction.pages,
    headings: stored.extraction.headings,
    skipped: stored.extraction.skipped,
    sourceUnits: stored.sourceUnits,
  });

  if (segmentation.unaccountedPages.length > 0) {
    // The unaudited-`skipped[]` signal, made visible at the first point anything can act on
    // it. Not fatal — the document is still worth merging — but a reader must be able to see
    // that some of it went missing without being declared.
    await logProcessingEvent(admin, {
      userId,
      documentId,
      courseId,
      step: "route",
      level: "warn",
      detail: `${segmentation.unaccountedPages.length} page${segmentation.unaccountedPages.length === 1 ? "" : "s"} of this document were neither extracted nor declared skipped (${segmentation.unaccountedPages.slice(0, 8).join(", ")}${segmentation.unaccountedPages.length > 8 ? "…" : ""}). Citations to them cannot be verified.`,
    });
  }

  if (segmentation.segments.length === 0) {
    return {
      segments: [],
      routed: [],
      coercions: [],
      unaccountedPages: segmentation.unaccountedPages,
      coverageChecked: segmentation.coverageChecked,
    };
  }

  // ── A.2: embed each segment, retrieve top-5 by cosine ─────────────────────
  const segmentVectors = await input.embeddings.embed({
    texts: segmentation.segments.map((segment) => `${segment.title}\n\n${segment.markdown}`),
    inputType: "document",
    purpose: "embed-segment",
  });

  const routable: RoutableSegment[] = segmentation.segments.map((segment, index) => {
    const vector = segmentVectors.embeddings[index];
    const scored = input.existingTopics
      .map((topic) => {
        // Both vectors are candidates for the same topic — §5 Step A.2 retrieves against
        // `title_embedding` AND the summary embedding. The better of the two scores wins,
        // because a segment can match a topic through either its name or its content and
        // averaging them would let a strong match on one be diluted by a weak other.
        const scores = [topic.titleEmbedding, topic.summaryEmbedding]
          .map((candidate) =>
            vector === undefined || candidate === null ? null : cosineSimilarity(vector, candidate),
          )
          .filter((score): score is number => score !== null);
        return { id: topic.id, title: topic.title, similarity: Math.max(...scores, -1) };
      })
      .filter((candidate) => candidate.similarity > -1)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, CANDIDATES_PER_SEGMENT);

    return {
      key: segment.key,
      title: segment.title,
      markdown: segment.markdown,
      candidates: scored,
    };
  });

  // ── A.3: ONE batched routing call for the whole document ──────────────────
  const result = await routeSegments({
    runtime: input.runtime,
    courseTitle: input.courseTitle,
    topicIndex: input.existingTopics.map((topic) => ({
      id: topic.id,
      title: topic.title,
      summary: topic.summary,
      keyTerms: topic.page.keyTerms.slice(0, INDEX_KEY_TERMS).map((term) => term.term),
    })),
    segments: routable,
    documentLabel: input.filename,
    sessionLabel: input.sessionLabel,
  });

  if (result.status === "dead-letter") {
    // Terminal for the document: the ladder already spent a corrective retry and a
    // cross-family escalation, so an Inngest retry buys three more identical failures at
    // full price. Same reasoning as `extract`'s dead-letter branch.
    throw new RoutingDeadLetterError(result.reason, result.message);
  }

  const byKey = new Map(segmentation.segments.map((segment) => [segment.key, segment]));

  // ── A.4: the deterministic duplicate guard ────────────────────────────────
  //
  // Every proposed NEW title is embedded and checked. Assignments cost nothing here, so
  // only the creates are embedded — on a document that routes cleanly into an existing
  // index that is zero extra tokens.
  const createTitles = result.value.decisions
    .filter((decision) => decision.assignToTopicId === null && decision.createNewTitle !== null)
    .map((decision) => decision.createNewTitle ?? "");

  const titleVectors =
    createTitles.length === 0
      ? { embeddings: [] as readonly (readonly number[])[] }
      : await input.embeddings.embed({
          texts: createTitles,
          inputType: "document",
          purpose: "embed-topic-title",
        });

  let titleCursor = 0;
  const proposals: RoutingProposal[] = [];
  for (const decision of result.value.decisions) {
    if (!byKey.has(decision.segmentKey)) {
      // The model invented or mangled a segment key. Dropping it is right — there is no
      // segment to merge — but it must be visible, not silent.
      await logProcessingEvent(admin, {
        userId,
        documentId,
        courseId,
        step: "route",
        level: "warn",
        detail: `Routing returned a decision for an unknown segment "${decision.segmentKey}"; it was ignored.`,
      });
      continue;
    }

    const assigned = decision.assignToTopicId;
    if (assigned !== null && assigned !== "") {
      proposals.push({ segmentKey: decision.segmentKey, kind: "assign", topicId: assigned });
      continue;
    }

    const title = decision.createNewTitle ?? "";
    const embedding = titleVectors.embeddings[titleCursor] ?? null;
    titleCursor += 1;
    proposals.push({
      segmentKey: decision.segmentKey,
      kind: "create",
      title,
      rationale: decision.rationale,
      titleEmbedding: embedding,
    });
  }

  const existingTitles: ExistingTopicTitle[] = input.existingTopics.map((topic) => ({
    id: topic.id,
    title: topic.title,
    titleEmbedding: topic.titleEmbedding,
  }));

  const guarded = applyDuplicateGuard({ proposals, existingTopics: existingTitles });

  for (const coercion of guarded.coercions) {
    await logProcessingEvent(admin, {
      userId,
      documentId,
      courseId,
      step: "route",
      level: "warn",
      detail:
        coercion.reason === "coerced-to-existing"
          ? `Proposed new topic “${coercion.proposedTitle}” is ${(coercion.similarity * 100).toFixed(0)}% similar to the existing “${coercion.matchedTitle}” — merged into it instead of creating a duplicate.`
          : `Proposed new topic “${coercion.proposedTitle}” duplicates “${coercion.matchedTitle}” from earlier in this same document — both were merged into one new topic.`,
    });
  }

  for (const gap of guarded.unguarded) {
    await logProcessingEvent(admin, {
      userId,
      documentId,
      courseId,
      step: "route",
      level: "warn",
      detail: `The duplicate check could not run on proposed topic “${gap.proposedTitle}” (${gap.reason}); it was created unchecked.`,
    });
  }

  return {
    segments: segmentation.segments,
    routed: guarded.routed,
    coercions: guarded.coercions,
    unaccountedPages: segmentation.unaccountedPages,
    coverageChecked: segmentation.coverageChecked,
  };
}

export class RoutingDeadLetterError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(`Topic routing dead-lettered (${reason}): ${message}`);
    this.name = "RoutingDeadLetterError";
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Steps B / B2 / C — merge, verify, persist                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/** One topic's worth of work: which topic, and which of this document's segments feed it. */
interface MergeTarget {
  /** Present for an existing topic; absent when this merge creates it. */
  readonly topicId: string | null;
  /** Stable id for logging and for `failed_topics`. The topic id, or the proposal key. */
  readonly topicKey: string;
  readonly title: string;
  readonly current: StoredTopicPage;
  readonly currentRevision: number;
  readonly segments: readonly Segment[];
}

/** Groups routed segments into one work item per affected topic. */
function planMerges(
  routed: readonly RoutedSegment[],
  segments: readonly Segment[],
  existingTopics: readonly ExistingTopic[],
): readonly MergeTarget[] {
  const byKey = new Map(segments.map((segment) => [segment.key, segment]));
  const topicsById = new Map(existingTopics.map((topic) => [topic.id, topic]));
  const targets = new Map<string, { target: MergeTarget; segments: Segment[] }>();

  for (const entry of routed) {
    const segment = byKey.get(entry.segmentKey);
    if (segment === undefined) continue;

    if (entry.kind === "assign") {
      const topic = topicsById.get(entry.topicId);
      // A routing decision naming a topic that is not in this course's index is dropped
      // rather than trusted: the alternative is writing into another course's topic through
      // the RLS-bypassing admin client on the strength of a model-generated uuid.
      if (topic === undefined) continue;
      const existing = targets.get(entry.topicId);
      if (existing === undefined) {
        targets.set(entry.topicId, {
          target: {
            topicId: topic.id,
            topicKey: topic.id,
            title: topic.title,
            current: topic.page,
            currentRevision: topic.revision,
            segments: [],
          },
          segments: [segment],
        });
      } else {
        existing.segments.push(segment);
      }
      continue;
    }

    const existing = targets.get(entry.proposalKey);
    if (existing === undefined) {
      targets.set(entry.proposalKey, {
        target: {
          topicId: null,
          topicKey: entry.proposalKey,
          title: entry.title,
          current: EMPTY_TOPIC_PAGE,
          currentRevision: 0,
          segments: [],
        },
        segments: [segment],
      });
    } else {
      existing.segments.push(segment);
    }
  }

  return [...targets.values()].map(({ target, segments: grouped }) => ({
    ...target,
    // Ascending page order, so the merger reads the document the way it was written.
    segments: [...grouped].sort((a, b) => a.fromPage - b.fromPage),
  }));
}

/** A finding rendered for the re-merge prompt and for the progress feed. */
function describeFinding(finding: LossFinding): string {
  return `[${finding.severity}] ${finding.detail}`;
}

interface VerifiedMerge {
  readonly merge: TopicMerge;
  readonly needsReview: boolean;
  readonly findings: readonly string[];
  readonly remerged: boolean;
}

/**
 * Step B2 in full: deterministic check, then critic, then at most **one** re-merge.
 *
 * The routing on the verdict is PLAN's, exactly: clean → persist silently; flagged → one
 * automatic re-merge with the issues appended; still flagged → persist anyway with
 * `needs_review = true` and a `warn` event. **Never a silent bad merge, never a hard
 * block.** A hard block would be the worse failure: a student who uploaded a deck and got
 * nothing is strictly worse off than one who got a page with a "review this" chip on it.
 *
 * The deterministic half runs first and always, including on the re-merged output. It is
 * free, so there is no reason to gate it behind the critic — and if the critic call itself
 * fails, the loss-detector's verdict still stands on its own.
 */
async function verifyMerge(input: {
  readonly admin: SupabaseAdminClient;
  readonly userId: string;
  readonly documentId: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly filename: string;
  readonly sessionLabel: string | null;
  readonly target: MergeTarget;
  readonly merge: TopicMerge;
  readonly routedPages: readonly number[];
  readonly unaccountedPages: readonly number[];
  readonly coverageChecked: boolean;
  readonly runtime: ReturnType<typeof createStudyAIRuntime>;
}): Promise<VerifiedMerge> {
  const { target, merge } = input;

  const check = (candidate: TopicMerge): readonly string[] => {
    const loss = detectMergeLoss({
      before: target.current,
      after: candidate.page,
      removals: candidate.removals,
      documentId: input.documentId,
      routedPages: input.routedPages,
      unaccountedPages: input.unaccountedPages,
      coverageChecked: input.coverageChecked,
    });
    // Only RED findings gate. Amber ones — a phantom removal, an unverifiable citation
    // against a lossy extraction — are recorded but must not spend a second Sonnet call:
    // an amber finding is by construction something the re-merge has no way to fix.
    return loss.findings.filter((finding) => finding.severity === "red").map(describeFinding);
  };

  const criticise = async (candidate: TopicMerge): Promise<readonly string[]> => {
    const verdict = await criticiseMerge({
      runtime: input.runtime,
      topicTitle: target.title,
      oldPage: JSON.stringify(target.current),
      proposedPage: JSON.stringify(candidate.page),
      changeSummary: candidate.changeSummary,
      removals: candidate.removals,
      segments: target.segments,
    });
    if (verdict.status === "dead-letter") {
      // The critic failing is not the merge failing. Persisting an unreviewed merge is the
      // documented fallback ("never a hard block"), and it is recorded as an issue so the
      // page still carries the review chip rather than passing as verified.
      return [
        `[critic] The reviewer could not be run (${verdict.reason}); this merge was not verified.`,
      ];
    }
    if (verdict.value.ok && verdict.value.severity !== "major") return [];
    return verdict.value.issues.map((issue) => `[critic:${issue.kind}] ${issue.detail}`);
  };

  const firstIssues = [...check(merge), ...(await criticise(merge))];
  if (firstIssues.length === 0) {
    return { merge, needsReview: false, findings: [], remerged: false };
  }

  await logProcessingEvent(input.admin, {
    userId: input.userId,
    documentId: input.documentId,
    courseId: input.courseId,
    step: `merge:topic:${target.topicKey}`,
    detail: `Review found ${firstIssues.length} issue${firstIssues.length === 1 ? "" : "s"} with “${target.title}”; merging again.`,
  });

  // ── The ONE automatic re-merge ────────────────────────────────────────────
  const second = await remergeTopic({
    runtime: input.runtime,
    courseTitle: input.courseTitle,
    topicTitle: target.title,
    isNewTopic: target.topicId === null,
    currentPage: JSON.stringify(target.current),
    currentBlockKeys: flattenTopicPage(target.current).map((block) => block.key),
    documentId: input.documentId,
    documentLabel: input.filename,
    sessionLabel: input.sessionLabel,
    segments: target.segments,
    proposedPage: JSON.stringify(merge.page),
    changeSummary: merge.changeSummary,
    issues: firstIssues,
  });

  if (second.status === "dead-letter") {
    // Keep the first merge. It is the best content available, and it goes in flagged.
    return { merge, needsReview: true, findings: firstIssues, remerged: true };
  }

  const secondIssues = [...check(second.value), ...(await criticise(second.value))];
  return {
    merge: second.value,
    needsReview: secondIssues.length > 0,
    findings: secondIssues,
    remerged: true,
  };
}

/**
 * Step C — persist one topic.
 *
 * PLAN says "in one transaction". PostgREST has no multi-statement transaction, so the
 * ordering here is chosen so that **every prefix of it is a consistent state**:
 *
 * 1. the pre-merge `topic_revisions` snapshot goes FIRST. History before mutation means a
 *    crash between the two leaves a recoverable page, never an overwritten one with no
 *    snapshot to revert to.
 * 2. `topics` is updated with the new page, summary, embedding and `revision + 1`.
 * 3. `topic_sources` is upserted last — it is provenance, and a missing row costs a
 *    re-processing hint rather than any content.
 *
 * A step re-run repeats all three. (1) is guarded by `unique (topic_id, revision)`, (3) by
 * `unique (topic_id, document_id)` — Gate 1 F4's idempotency key — so the only non-idempotent
 * write is (2), which is a full replace and therefore idempotent by construction.
 */
async function persistTopicMerge(input: {
  readonly admin: SupabaseAdminClient;
  readonly userId: string;
  readonly documentId: string;
  readonly courseId: string;
  readonly target: MergeTarget;
  readonly verified: VerifiedMerge;
  readonly summaryEmbedding: readonly number[] | null;
  readonly stamp: {
    readonly promptId: string;
    readonly promptVersion: number;
    readonly provider: string;
    readonly model: string;
    readonly inputHash: string;
  };
  readonly takenSlugs: ReadonlySet<string>;
}): Promise<{ readonly topicId: string; readonly slug: string | null }> {
  const { admin, userId, documentId, courseId, target, verified, stamp } = input;
  const page = verified.merge.page;

  let topicId = target.topicId;
  let createdSlug: string | null = null;

  if (topicId === null) {
    const slug = slugFor(verified.merge.title || target.title, input.takenSlugs);
    createdSlug = slug;
    const { data, error } = await admin
      .from("topics")
      .insert({
        user_id: userId,
        course_id: courseId,
        title: verified.merge.title || target.title,
        slug,
        summary: page.summary,
        page,
        revision: 1,
        ...(input.summaryEmbedding === null
          ? {}
          : { summary_embedding: toStoredVector(input.summaryEmbedding) }),
      })
      .select("id")
      .single();

    if (error || data === null) {
      throw new Error(`Could not create topic “${target.title}”: ${error?.message ?? "no row"}`);
    }
    topicId = data.id;
  } else {
    // (1) history first — see the ordering note above.
    const { error: revisionError } = await admin.from("topic_revisions").insert({
      user_id: userId,
      topic_id: topicId,
      revision: target.currentRevision,
      page: target.current,
      change_summary: verified.merge.changeSummary,
      source: "merge",
      needs_review: verified.needsReview,
      document_id: documentId,
      prompt_id: stamp.promptId,
      prompt_version: stamp.promptVersion,
      provider: stamp.provider,
      model: stamp.model,
      input_hash: stamp.inputHash,
    });

    // A duplicate (topic_id, revision) means this exact step already ran and its snapshot
    // is already stored — the re-run case. Anything else is a real failure.
    if (revisionError !== null && revisionError.code !== "23505") {
      throw new Error(`Could not snapshot topic ${topicId}: ${revisionError.message}`);
    }

    // (2) the page itself.
    const { error: updateError } = await admin
      .from("topics")
      .update({
        title: verified.merge.title || target.title,
        summary: page.summary,
        page,
        revision: target.currentRevision + 1,
        ...(input.summaryEmbedding === null
          ? {}
          : { summary_embedding: toStoredVector(input.summaryEmbedding) }),
      })
      .eq("id", topicId)
      .eq("user_id", userId);

    if (updateError) throw new Error(`Could not update topic ${topicId}: ${updateError.message}`);
  }

  // (3) provenance. `onConflict` on the table's own unique key makes the re-run a no-op
  // update rather than a duplicate-key error — Gate 1 F4 calls this the idempotency key for
  // re-processing, so it has to actually behave like one.
  const locators = [...new Set(target.segments.flatMap((segment) => segment.pages))]
    .sort((a, b) => a - b)
    .map((page_) => ({ page: page_ }));

  const { error: sourceError } = await admin
    .from("topic_sources")
    .upsert(
      { user_id: userId, topic_id: topicId, document_id: documentId, locators },
      { onConflict: "topic_id,document_id" },
    );

  if (sourceError) {
    throw new Error(`Could not record provenance for topic ${topicId}: ${sourceError.message}`);
  }

  return { topicId, slug: createdSlug };
}

/**
 * Steps B → B2 → C for every affected topic, isolating failures (PLAN §7).
 *
 * The `try` around each topic is the partial-success mechanism, and it is deliberately as
 * wide as one topic and no wider: a failure inside it costs that topic and nothing else,
 * and the error text lands in `failed_topics` for `document/retry-merges` rather than in
 * `failure_reason`, which a person reads.
 */
async function mergeTopics(input: {
  readonly admin: SupabaseAdminClient;
  readonly userId: string;
  readonly documentId: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly filename: string;
  readonly sessionLabel: string | null;
  readonly targets: readonly MergeTarget[];
  readonly unaccountedPages: readonly number[];
  readonly coverageChecked: boolean;
  readonly takenSlugs: Set<string>;
  readonly embeddings: EmbeddingClient;
  readonly runtime: ReturnType<typeof createStudyAIRuntime>;
}): Promise<{ readonly outcomes: readonly TopicMergeOutcome[]; readonly created: number }> {
  const outcomes: TopicMergeOutcome[] = [];
  let created = 0;

  for (const target of input.targets) {
    const step = `merge:topic:${target.topicKey}`;
    try {
      await logProcessingEvent(input.admin, {
        userId: input.userId,
        documentId: input.documentId,
        courseId: input.courseId,
        step,
        detail: `${target.topicId === null ? "Creating" : "Updating"} “${target.title}” from ${target.segments.length} section${target.segments.length === 1 ? "" : "s"}.`,
      });

      // ── Step B ────────────────────────────────────────────────────────────
      const merged = await mergeTopic({
        runtime: input.runtime,
        courseTitle: input.courseTitle,
        topicTitle: target.title,
        isNewTopic: target.topicId === null,
        currentPage: JSON.stringify(target.current),
        currentBlockKeys: flattenTopicPage(target.current).map((block) => block.key),
        documentId: input.documentId,
        documentLabel: input.filename,
        sessionLabel: input.sessionLabel,
        segments: target.segments,
      });

      if (merged.status === "dead-letter") {
        throw new Error(`merge dead-lettered (${merged.reason}): ${merged.message}`);
      }

      // ── Step B2 ───────────────────────────────────────────────────────────
      const routedPages = [...new Set(target.segments.flatMap((segment) => segment.pages))];
      const verified = await verifyMerge({
        admin: input.admin,
        userId: input.userId,
        documentId: input.documentId,
        courseId: input.courseId,
        courseTitle: input.courseTitle,
        filename: input.filename,
        sessionLabel: input.sessionLabel,
        target,
        merge: merged.value,
        routedPages,
        unaccountedPages: input.unaccountedPages,
        coverageChecked: input.coverageChecked,
        runtime: input.runtime,
      });

      // ── Step C: re-embed the new summary, then persist ────────────────────
      //
      // A failed embedding must not fail the merge: PLAN §7 puts embedding failures on the
      // `partial` path, and a topic page with a stale routing vector is far better than no
      // topic page. The next merge refreshes it.
      let summaryEmbedding: readonly number[] | null = null;
      try {
        const embedded = await input.embeddings.embed({
          texts: [`${verified.merge.title}\n\n${verified.merge.page.summary}`],
          inputType: "document",
          purpose: "embed-topic-summary",
        });
        summaryEmbedding = embedded.embeddings[0] ?? null;
      } catch (error) {
        await logProcessingEvent(input.admin, {
          userId: input.userId,
          documentId: input.documentId,
          courseId: input.courseId,
          step,
          level: "warn",
          detail: `Could not refresh the search vector for “${target.title}”; the page is saved and searchable on its previous vector.`,
        });
        console.error(`[route-and-merge] summary embedding failed for ${target.topicKey}:`, error);
      }

      const { slug } = await persistTopicMerge({
        admin: input.admin,
        userId: input.userId,
        documentId: input.documentId,
        courseId: input.courseId,
        target,
        verified,
        summaryEmbedding,
        stamp: {
          promptId: merged.stamp.promptId,
          promptVersion: merged.stamp.promptVersion,
          provider: merged.stamp.provider,
          model: merged.stamp.model,
          inputHash: merged.stamp.inputHash,
        },
        takenSlugs: input.takenSlugs,
      });

      if (slug !== null) {
        input.takenSlugs.add(slug);
        created += 1;
      }

      if (verified.needsReview) {
        await logProcessingEvent(input.admin, {
          userId: input.userId,
          documentId: input.documentId,
          courseId: input.courseId,
          step,
          level: "warn",
          detail: `“${target.title}” was saved but flagged for review: ${verified.findings[0] ?? "the reviewer was not satisfied after a second attempt."}`,
        });
      } else {
        await logProcessingEvent(input.admin, {
          userId: input.userId,
          documentId: input.documentId,
          courseId: input.courseId,
          step,
          detail: `“${target.title}”: ${verified.merge.changeSummary}`,
        });
      }

      outcomes.push({
        topicKey: target.topicKey,
        status: "merged",
        needsReview: verified.needsReview,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await logProcessingEvent(input.admin, {
        userId: input.userId,
        documentId: input.documentId,
        courseId: input.courseId,
        step,
        level: "error",
        detail: `“${target.title}” could not be updated from this file. The rest of the document was still processed.`,
      });
      console.error(`[route-and-merge] topic ${target.topicKey} failed:`, error);
      outcomes.push({ topicKey: target.topicKey, status: "failed", error: message });
    }
  }

  return { outcomes, created };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The step body                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The whole of §5 Steps A–C, as one Inngest step body.
 *
 * One step rather than one per topic, and that is a trade worth naming. Per-topic steps
 * would give each topic its own retry budget and a nicer dashboard; they would also require
 * the routing result to be serialized into the run's state between steps, and a document's
 * segments are large enough that this is exactly the mistake `extract` avoided by putting
 * the extraction in Postgres instead of in the step's return value. Isolation — the property
 * §7 actually asks for — is provided by the per-topic `try` in {@link mergeTopics}, not by
 * the step boundary.
 */
export async function runRouteAndMerge(input: RouteAndMergeInput): Promise<RouteAndMergeSummary> {
  const { admin, userId, documentId, courseId } = input;
  const startedAt = Date.now();

  await setDocumentStatus(admin, documentId, userId, { status: "merging" });

  const runtime = createStudyAIRuntime({ userId });
  const embeddings = createStudyEmbeddingClient({ userId });

  const existingTopics = await loadCourseTopics(admin, userId, courseId);

  await logProcessingEvent(admin, {
    userId,
    documentId,
    courseId,
    step: "route",
    detail:
      existingTopics.length === 0
        ? "Working out what this covers. This course has no topics yet."
        : `Working out how this fits the ${existingTopics.length} topic${existingTopics.length === 1 ? "" : "s"} already in this course.`,
  });

  const routing = await runRouting({
    admin,
    userId,
    documentId,
    courseId,
    courseTitle: input.courseTitle,
    filename: input.filename,
    sessionLabel: input.sessionLabel,
    existingTopics,
    embeddings,
    runtime,
  });

  const targets = planMerges(routing.routed, routing.segments, existingTopics);

  const { data: slugRows } = await admin
    .from("topics")
    .select("slug")
    .eq("user_id", userId)
    .eq("course_id", courseId);
  const takenSlugs = new Set((slugRows ?? []).map((row) => row.slug));

  const { outcomes, created } = await mergeTopics({
    admin,
    userId,
    documentId,
    courseId,
    courseTitle: input.courseTitle,
    filename: input.filename,
    sessionLabel: input.sessionLabel,
    targets,
    unaccountedPages: routing.unaccountedPages,
    coverageChecked: routing.coverageChecked,
    takenSlugs,
    embeddings,
    runtime,
  });

  const outcome = computeDocumentOutcome({ topicOutcomes: outcomes });

  return {
    outcome,
    topicOutcomes: outcomes,
    segments: routing.segments.length,
    topicsTouched: targets.length,
    topicsCreated: created,
    coercions: routing.coercions.length,
    unaccountedPages: routing.unaccountedPages.length,
    costUsd: await mergeCost(admin, userId, documentId),
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * What routing + merging + criticism cost, read back from the metering rows.
 *
 * Read from `ai_generations` rather than accumulated in process, for the reason `extract`
 * gives: that table is what §6 bills against, so if the two ever disagree the table is
 * right and the in-memory number is a story. Scoped by job rather than by `input_hash` —
 * this step makes many calls with many hashes, and the jobs are exactly the set it owns.
 *
 * ⚠ It is time-bounded to this run by nothing at all, so a re-processed document counts
 * both runs. That over-reports rather than under-reports, which is the right direction for
 * a number shown next to a budget.
 */
async function mergeCost(
  admin: SupabaseAdminClient,
  userId: string,
  _documentId: string,
): Promise<number | null> {
  const { data, error } = await admin
    .from("ai_generations")
    .select("cost_usd")
    .eq("user_id", userId)
    .in("job", [
      "topic-routing",
      "topic-merge",
      "merge-critic",
      "embed-segment",
      "embed-topic-title",
      "embed-topic-summary",
    ])
    .gte("created_at", new Date(Date.now() - 60 * 60 * 1000).toISOString());

  if (error || data === null || data.length === 0) return null;
  const priced = data.filter((row): row is { cost_usd: number } => row.cost_usd !== null);
  if (priced.length === 0) return null;
  return priced.reduce((total, row) => total + row.cost_usd, 0);
}
