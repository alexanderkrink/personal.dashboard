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
  topicRoutingPrompt,
} from "@study/ai";
import {
  applyDuplicateGuard,
  coalesceSingletonCreates,
  computeDocumentOutcome,
  cosineSimilarity,
  type DocumentOutcome,
  type DuplicateCoercion,
  detectMergeLoss,
  detectSingleTopicFunnel,
  detectUngroundedContent,
  type ExistingTopicTitle,
  flattenTopicPage,
  type LossFinding,
  measureExpansion,
  type PriorContribution,
  planMergeWork,
  type RoutedSegment,
  type RoutingProposal,
  type RoutingResolution,
  resolveRoutingDecisions,
  type Segment,
  type SingletonFold,
  type SkippedTarget,
  segmentExtraction,
  type TopicMergeOutcome,
} from "@study/core";
import type { SupabaseAdminClient } from "@study/db";
import { z } from "zod";
import { logProcessingEvent, setDocumentStatus } from "@/inngest/documents";
import { createStudyEmbeddingClient, parseStoredVector, toStoredVector } from "@/lib/ai/embeddings";
import { createStudyAIRuntime } from "@/lib/ai/runtime";
import { extractionHash } from "@/lib/documents/extraction-hash";

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
  /**
   * Distinct segments that reached a merge target. **Not** `topicsTouched`, which counts
   * topics — a distinction that hid the Wave 4 failure, where 1 segment produced 1 topic and
   * the summary read as though the document had been processed.
   */
  readonly segmentsMerged: number;
  readonly topicsTouched: number;
  readonly topicsCreated: number;
  readonly coercions: number;
  /** One-slide topics folded into their deck-adjacent section by the singleton coalesce. */
  readonly singletonFolds: number;
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

/**
 * What this document has already contributed to this course's topics.
 *
 * Empty on a first run — two indexed lookups that cost nothing — and the whole basis for
 * convergence on a second one. Both witnesses are needed because Step C's three writes are
 * not transactional; {@link planMergeWork} documents the truth table they feed.
 *
 * The snapshot query takes the **highest** revision per topic rather than the first. On a
 * clean history there is exactly one row per (topic, document) — the trigger added in
 * `20260719224933` now makes that structural — but on a document that compounded before that
 * migration existed, the newest snapshot is the one that says where the topic actually got
 * to, and the older ones are dead history.
 */
async function loadPriorContributions(
  admin: SupabaseAdminClient,
  userId: string,
  documentId: string,
): Promise<readonly PriorContribution[]> {
  const [snapshots, provenance] = await Promise.all([
    admin
      .from("topic_revisions")
      .select("topic_id, revision")
      .eq("user_id", userId)
      .eq("document_id", documentId)
      .eq("source", "merge"),
    admin
      .from("topic_sources")
      .select("topic_id")
      .eq("user_id", userId)
      .eq("document_id", documentId),
  ]);

  if (snapshots.error) {
    throw new Error(
      `Could not read prior merge snapshots for ${documentId}: ${snapshots.error.message}`,
    );
  }
  if (provenance.error) {
    throw new Error(
      `Could not read prior provenance for ${documentId}: ${provenance.error.message}`,
    );
  }

  const highestSnapshot = new Map<string, number>();
  for (const row of snapshots.data ?? []) {
    highestSnapshot.set(
      row.topic_id,
      Math.max(highestSnapshot.get(row.topic_id) ?? 0, row.revision),
    );
  }

  const withProvenance = new Set((provenance.data ?? []).map((row) => row.topic_id));

  return [...new Set([...highestSnapshot.keys(), ...withProvenance])].map((topicId) => ({
    topicId,
    snapshotRevision: highestSnapshot.get(topicId) ?? null,
    hasProvenance: withProvenance.has(topicId),
  }));
}

/**
 * Writes the provenance row a crash between Step C's (2) and (3) never got to write.
 *
 * Deliberately not a merge: the page already holds this document's contribution, so the only
 * thing missing is the record of it. `topic_sources` is what `process-document` reads to
 * decide which topics changed and what coverage reports against, so a topic left out of it
 * would be invisible to both despite being correctly merged.
 */
async function repairProvenance(input: {
  readonly admin: SupabaseAdminClient;
  readonly userId: string;
  readonly documentId: string;
  readonly skipped: SkippedTarget;
  readonly segments: readonly Segment[];
}): Promise<void> {
  const locators = [...new Set(input.segments.flatMap((segment) => segment.pages))]
    .sort((a, b) => a - b)
    .map((page) => ({ page }));

  const { error } = await input.admin.from("topic_sources").upsert(
    {
      user_id: input.userId,
      topic_id: input.skipped.topicId,
      document_id: input.documentId,
      locators,
      merged_at_revision: input.skipped.mergedAtRevision,
    },
    { onConflict: "topic_id,document_id" },
  );

  if (error) {
    throw new Error(
      `Could not repair provenance for topic ${input.skipped.topicId}: ${error.message}`,
    );
  }
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
  /** One-slide topics folded into their deck-adjacent section (Step A.4½). */
  readonly folds: readonly SingletonFold[];
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
      folds: [],
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

  // ── A.3.1: adjudicate the batch BEFORE embedding anything ─────────────────
  //
  // `resolveRoutingDecisions` is pure and lives in `@study/core`. It owns three things this
  // loop used to do inline and got wrong:
  //
  //  1. an `assignToTopicId` naming a topic **this same batch is creating**, by title,
  //     because the schema gives the model no way to name a topic that has no id yet. That
  //     is the normal shape of routing into an empty course, and reading it as a broken uuid
  //     is what lost 47 of 48 segments in Wave 4;
  //  2. an `assignToTopicId` naming nothing at all, which is never followed;
  //  3. the arity `routingBatchSchema` describes but does not enforce — a segment with no
  //     decision, or with two.
  //
  // Adjudicating first is also what makes the title embeddings correct. The old code chose
  // which titles to embed with one predicate and which proposals were creates with a
  // *different* one, then walked the embedding array with a cursor — so a single decision
  // the two predicates disagreed about mis-paired every vector after it.
  const resolution = resolveRoutingDecisions({
    decisions: result.value.decisions,
    segments: segmentation.segments,
    knownTopicIds: input.existingTopics.map((topic) => topic.id),
  });

  await reportRoutingResolution({ admin, userId, documentId, courseId, resolution });

  // ── A.4: the deterministic duplicate guard ────────────────────────────────
  //
  // Every proposed NEW title is embedded and checked. Assignments to a real topic cost
  // nothing here, so only the creates are embedded — on a document that routes cleanly into
  // an existing index that is zero extra tokens.
  const createIndexes = resolution.proposals
    .map((proposal, index) => (proposal.kind === "create" ? index : -1))
    .filter((index) => index >= 0);
  const createTitles = createIndexes.map((index) => {
    const proposal = resolution.proposals[index];
    return proposal !== undefined && proposal.kind === "create" ? proposal.title : "";
  });

  const titleVectors =
    createTitles.length === 0
      ? { embeddings: [] as readonly (readonly number[])[] }
      : await input.embeddings.embed({
          texts: createTitles,
          inputType: "document",
          purpose: "embed-topic-title",
        });

  // Paired by position against the list that was actually sent, not by a cursor walked over
  // a differently-filtered list.
  const embeddingByProposal = new Map<number, readonly number[] | null>(
    createIndexes.map((proposalIndex, i) => [proposalIndex, titleVectors.embeddings[i] ?? null]),
  );

  const proposals: RoutingProposal[] = resolution.proposals.map((proposal, index) =>
    proposal.kind === "assign"
      ? proposal
      : {
          segmentKey: proposal.segmentKey,
          kind: "create",
          title: proposal.title,
          rationale: proposal.rationale,
          titleEmbedding: embeddingByProposal.get(index) ?? null,
        },
  );

  const existingTitles: ExistingTopicTitle[] = input.existingTopics.map((topic) => ({
    id: topic.id,
    title: topic.title,
    titleEmbedding: topic.titleEmbedding,
  }));

  const guarded = applyDuplicateGuard({ proposals, existingTopics: existingTitles });

  for (const coercion of guarded.coercions) {
    // Levels encode normal vs fault. `coerced-to-existing` is the guard overriding the
    // router — a person should see that. `merged-into-proposal` is identical titles
    // grouping onto one create, the ordinary batch shape since Wave 6's guard folds on
    // title identity only — the 2026-07-21 run emitted 46 of these as warns, which is a
    // channel-destroying amount of crying wolf.
    await logProcessingEvent(admin, {
      userId,
      documentId,
      courseId,
      step: "route",
      level: coercion.reason === "coerced-to-existing" ? "warn" : "info",
      detail:
        coercion.reason === "coerced-to-existing"
          ? `Proposed new topic “${coercion.proposedTitle}” is ${(coercion.similarity * 100).toFixed(0)}% similar to the existing “${coercion.matchedTitle}” — merged into it instead of creating a duplicate.`
          : `Section named new topic “${coercion.proposedTitle}” again — grouped with the earlier “${coercion.matchedTitle}” as one new topic.`,
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

  // ── A.4½: the singleton coalesce (Wave 6 phase 2) ─────────────────────────
  //
  // Deterministic, downstream of the guard, upstream of `planMerges` — the canonical order
  // is resolve → duplicate guard → singleton coalesce → planMerges. A proposed NEW topic
  // carrying exactly one segment folds into the nearest deck-adjacent multi-segment
  // create; an all-singleton routing folds nothing, which is what keeps this step
  // structurally unable to rebuild the 1-topic funnel (that shape stays the funnel
  // backstop's case). Logged at `info`, one line per fold: this is the step working as
  // designed, not a fault, and the fold is the reader's answer to "where did the
  // one-slide topic the router named go?".
  const coalesced = coalesceSingletonCreates({
    routed: guarded.routed,
    segmentOrder: segmentation.segments.map((segment) => segment.key),
  });

  for (const fold of coalesced.folds) {
    await logProcessingEvent(admin, {
      userId,
      documentId,
      courseId,
      step: "route",
      level: "info",
      detail: `Folded one-slide topic “${fold.foldedTitle}” into its neighbouring section “${fold.intoTitle}” — one slide does not make its own topic.`,
    });
  }

  return {
    segments: segmentation.segments,
    routed: coalesced.routed,
    coercions: guarded.coercions,
    folds: coalesced.folds,
    unaccountedPages: segmentation.unaccountedPages,
    coverageChecked: segmentation.coverageChecked,
  };
}

/**
 * Everything the adjudicator changed or could not resolve, in the progress feed.
 *
 * The Wave 4 failure was invisible, and that was the whole problem: `planMerges` dropped 47
 * routed segments through the one branch in the pipeline that logged nothing, while every
 * sibling branch — unknown segment key, duplicate coercion, unaccounted pages — warned. The
 * levels below encode which departures are normal and which are faults, because a feed that
 * warns about the normal path teaches a reader to ignore it.
 */
async function reportRoutingResolution(input: {
  readonly admin: SupabaseAdminClient;
  readonly userId: string;
  readonly documentId: string;
  readonly courseId: string;
  readonly resolution: RoutingResolution;
}): Promise<void> {
  const { resolution } = input;
  const event = (level: "info" | "warn", detail: string) =>
    logProcessingEvent(input.admin, {
      userId: input.userId,
      documentId: input.documentId,
      courseId: input.courseId,
      step: "route",
      level,
      detail,
    });

  // Expected, not a fault: routing a document into a course with no topics produces exactly
  // this. Recorded at `info` so the grouping is legible without crying wolf.
  if (resolution.batchLocal.length > 0) {
    const titles = [...new Set(resolution.batchLocal.map((entry) => entry.title))];
    await event(
      "info",
      `${resolution.batchLocal.length} section${resolution.batchLocal.length === 1 ? " was" : "s were"} routed to ${titles.length} topic${titles.length === 1 ? "" : "s"} this file is creating (${titles.slice(0, 4).join(", ")}${titles.length > 4 ? "…" : ""}).`,
    );
  }

  // Faults, each of which used to be silent or fatal-by-omission.
  for (const entry of resolution.unresolvable) {
    await event(
      "warn",
      `Routing asked to file a section under “${entry.reference}”, which is not a topic in this course and not one this file creates. It was not followed — the section became “${entry.fallbackTitle}” instead.`,
    );
  }
  for (const key of resolution.unknownSegmentKeys) {
    await event("warn", `Routing returned a decision for an unknown section "${key}"; ignored.`);
  }
  if (resolution.duplicateSegmentKeys.length > 0) {
    await event(
      "warn",
      `Routing returned more than one decision for ${resolution.duplicateSegmentKeys.length} section${resolution.duplicateSegmentKeys.length === 1 ? "" : "s"} (${resolution.duplicateSegmentKeys.slice(0, 5).join(", ")}); only the first was used.`,
    );
  }
  if (resolution.segmentsWithoutDecision.length > 0) {
    await event(
      "warn",
      `Routing returned no decision for ${resolution.segmentsWithoutDecision.length} section${resolution.segmentsWithoutDecision.length === 1 ? "" : "s"} (${resolution.segmentsWithoutDecision.slice(0, 8).join(", ")}). Nothing in ${resolution.segmentsWithoutDecision.length === 1 ? "it" : "them"} reached your notes.`,
    );
  }

  // N1: the decision array itself, compactly, so the next incident is diagnosable from the
  // feed instead of from an `input_hash` preimage reconstruction. `ai_generations` stores no
  // response body and routing decisions are written to no table — which is precisely why
  // four independent investigations could not settle what the router returned.
  const digest = resolution.proposals
    .map((p) => `${p.segmentKey}→${p.kind === "assign" ? p.topicId : `new:${p.title}`}`)
    .join(", ");
  await event(
    "info",
    `Routing decisions (${resolution.proposals.length}): ${digest.length > 1800 ? `${digest.slice(0, 1800)}…` : digest}`,
  );
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

/** Cap for a persisted review note: a full "what's wrong" sentence, not a reasoning dump. */
const REVIEW_NOTE_MAX = 280;

/**
 * Flatten and bound one review note before it is persisted.
 *
 * The only place critic-authored text reaches `review_notes` is `[critic:<kind>] <detail>`,
 * where `<detail>` is raw gemini-3.1-flash-lite output that {@link mergeCriticSchema} does
 * not constrain. A model that leaks its chain-of-thought returns a multi-line, arbitrarily
 * long `detail`; persisted verbatim it folds a topic page's review drawer into a wall of
 * reasoning. So control characters (newlines included, which is what folds multi-line CoT)
 * become spaces, whitespace runs collapse, and the result is hard-capped with an ellipsis.
 */
export function sanitizeReviewNote(text: string): string {
  // Control characters (newlines included — that is what folds multi-line CoT into one note)
  // become spaces. Built from a codepoint scan rather than a control-character regex literal,
  // which Biome forbids in source.
  let flattened = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    flattened += code < 0x20 || code === 0x7f ? " " : char;
  }
  flattened = flattened.replace(/\s+/g, " ").trim();
  return flattened.length <= REVIEW_NOTE_MAX
    ? flattened
    : `${flattened.slice(0, REVIEW_NOTE_MAX - 1).trimEnd()}…`;
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

  // The literal text the merge prompt carried. Every grounding question below is asked
  // against THIS, not against the document — a merge can only be faithful to what it saw.
  const sourceText = target.segments.map((segment) => segment.markdown).join("\n\n");
  const isNewTopic = target.topicId === null;

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
    const red = loss.findings.filter((finding) => finding.severity === "red").map(describeFinding);

    // Grounding, against the merge's own input. Neither the loss-detector (which compares
    // two versions of the page) nor the critic (which is another model, and which on the
    // real failure was handed the same thin segment and waved six unsupported formulas
    // through) asks this question. These findings DO gate: unlike a thin input, "you stated
    // six formulas your source does not contain" is something a second pass can act on.
    const ungrounded = detectUngroundedContent({
      page: candidate.page,
      sourceText,
      isNewTopic,
    }).map((finding) => `[grounding] ${finding.detail}`);

    return [...red, ...ungrounded];
  };

  const criticise = async (candidate: TopicMerge): Promise<readonly string[]> => {
    const verdict = await criticiseMerge({
      runtime: input.runtime,
      topicTitle: target.title,
      isNewTopic,
      oldPage: JSON.stringify(target.current),
      proposedPage: JSON.stringify(candidate.page),
      changeSummary: candidate.changeSummary,
      removals: candidate.removals,
      segments: target.segments,
      // Counted here rather than asked of Flash-Lite. A model asked to count citations in a
      // 12,000-character JSON page will get it wrong, and the whole value of these two
      // numbers is that they are exact.
      citedPages: new Set(
        flattenTopicPage(candidate.page)
          .flatMap((block) => block.sources)
          .filter((source) => source.documentId === input.documentId)
          .map((source) => source.page)
          .filter((page): page is number => typeof page === "number"),
      ).size,
      availablePages: input.routedPages.length,
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
    // Sanitize at the ONE choke point where critic-authored text enters findings: `detail`
    // is raw gemini-3.1-flash-lite output, unconstrained by `mergeCriticSchema`. Both persist
    // branches (create RPC `p_review_notes`, update `review_notes`) read this same list, so
    // one sanitize here covers both.
    return verdict.value.issues.map((issue) =>
      sanitizeReviewNote(`[critic:${issue.kind}] ${issue.detail}`),
    );
  };

  // ── The thinness gate ─────────────────────────────────────────────────────
  //
  // Deliberately NOT part of `check()`, because a re-merge cannot fix it: the second pass
  // receives exactly the same segments as the first. What it can do is stop the page being
  // written as trustworthy. Wave 4 produced 12,296 characters from 577 — a 21× expansion —
  // and this catches that class whatever the upstream cause turns out to be, including
  // causes neither hypothesis about the routing failure named.
  const expansion = measureExpansion({ sourceText, page: merge.page, isNewTopic });
  const thinness = expansion.detail === null ? [] : [`[grounding] ${expansion.detail}`];

  const firstIssues = [...check(merge), ...(await criticise(merge))];
  if (firstIssues.length === 0) {
    return {
      merge,
      needsReview: thinness.length > 0,
      findings: thinness,
      remerged: false,
    };
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
    return { merge, needsReview: true, findings: [...firstIssues, ...thinness], remerged: true };
  }

  const secondIssues = [...check(second.value), ...(await criticise(second.value)), ...thinness];
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
 * ## ⚠ CORRECTED 2026-07-20 — what actually makes a re-run safe
 *
 * This docstring used to claim the three writes were idempotent on their own: "(1) is
 * guarded by `unique (topic_id, revision)`, (3) by `unique (topic_id, document_id)`, so the
 * only non-idempotent write is (2), which is a full replace". **That was false**, and the
 * final branch review measured why. `runRouteAndMerge` re-reads `topics.revision` fresh, so
 * on a second pass `target.currentRevision` is already the value the first pass bumped it
 * to. The `unique (topic_id, revision)` guard therefore could never fire — the write it
 * protects against is the one that moved the key — and (2) being a "full replace" is
 * irrelevant when the *content* being replaced in is a re-merge of a page that already holds
 * this document's contribution.
 *
 * What makes a re-run safe now is that the second pass **never reaches this function** for a
 * topic it already merged: {@link planMergeWork} partitions the targets first, and the
 * database refuses the compounding write outright via
 * `topic_revisions_one_merge_per_document` (migration `20260719224933`), which reads the
 * `topic_sources.merged_at_revision` this function writes at (3).
 *
 * The unique keys still do their narrower jobs. `unique (topic_id, revision)` absorbs a
 * re-run of the *identical* persist — a crash between (1) and (2) — and
 * `unique (topic_id, document_id)` keeps (3) an upsert rather than a duplicate-key error.
 * Neither of them was ever the thing standing between a retry and a doubled topic page.
 *
 * ## The window that remains open
 *
 * A crash between (2) and (3) leaves the page updated with no provenance row. The next pass
 * sees the snapshot at revision R with the topic already at R+1, skips the merge, and
 * repairs the missing `topic_sources` row (see `provenanceMissing`). That is why the skip
 * decision reads two witnesses instead of just `topic_sources` — reading provenance alone
 * would re-merge here.
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
  // Which `topics.revision` this merge leaves the topic at. A create starts at 1; an update
  // lands one past what it snapshotted. Recorded on the provenance row so the next pass — and
  // the database trigger behind it — can tell "already merged" from "not merged yet".
  const mergedAtRevision = target.topicId === null ? 1 : target.currentRevision + 1;

  if (topicId === null) {
    const slug = slugFor(verified.merge.title || target.title, input.takenSlugs);
    createdSlug = slug;

    // ── Topic AND its revision-0 snapshot, in ONE statement ──────────────────
    //
    // Not two calls in careful order. `needs_review` lives on `topic_revisions` and nowhere
    // else, so until Wave 5 the create branch inserted the topic, returned, and threw
    // `verified.needsReview` away — including the grounding findings and the expansion-ratio
    // gate, both of which exist specifically to catch a thin-input ungrounded NEW topic.
    // The path most likely to produce a bad page was the only one that could not be flagged.
    //
    // Two PostgREST calls are two transactions and can be interrupted between them, which is
    // how a topic ends up existing without the revision carrying its flag. The invariant is
    // therefore in the database: `create_topic_with_first_revision` does both inserts or
    // neither. See its migration for why revision 0 rather than 1.
    const { data, error } = await admin.rpc("create_topic_with_first_revision", {
      p_user_id: userId,
      p_course_id: courseId,
      p_title: verified.merge.title || target.title,
      p_slug: slug,
      p_summary: page.summary,
      p_page: page,
      // The page this create superseded. Empty, and supplied by the app rather than invented
      // in SQL so the two never drift.
      p_previous_page: EMPTY_TOPIC_PAGE,
      p_change_summary: verified.merge.changeSummary,
      p_needs_review: verified.needsReview,
      p_review_notes: [...verified.findings],
      p_document_id: documentId,
      p_prompt_id: stamp.promptId,
      p_prompt_version: stamp.promptVersion,
      p_provider: stamp.provider,
      p_model: stamp.model,
      p_input_hash: stamp.inputHash,
    });

    if (error !== null || data === null) {
      throw new Error(`Could not create topic “${target.title}”: ${error?.message ?? "no row"}`);
    }
    topicId = data;

    // The routing vector is applied separately and is deliberately allowed to fail: PLAN §7
    // puts embedding failures on the `partial` path, and keeping it out of the atomic pair
    // above means a Voyage outage cannot cost a topic its revision row.
    if (input.summaryEmbedding !== null) {
      const { error: vectorError } = await admin
        .from("topics")
        .update({ summary_embedding: toStoredVector(input.summaryEmbedding) })
        .eq("id", topicId)
        .eq("user_id", userId);
      if (vectorError !== null) {
        console.error(`[route-and-merge] summary vector not stored for ${topicId}:`, vectorError);
      }
    }
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
      // Why it was flagged, not just that it was. The verifier already renders these for a
      // person; before Wave 5 they were computed and dropped on both branches.
      review_notes: [...verified.findings],
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

  const { error: sourceError } = await admin.from("topic_sources").upsert(
    {
      user_id: userId,
      topic_id: topicId,
      document_id: documentId,
      locators,
      merged_at_revision: mergedAtRevision,
    },
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
  /**
   * Document-level findings that must ride every persisted revision this run writes —
   * today, the single-topic funnel backstop. Computed upstream because they judge the
   * routing SHAPE, which no per-topic verifier can see from inside one topic.
   */
  readonly backstopFindings: readonly string[];
  readonly takenSlugs: Set<string>;
  readonly embeddings: EmbeddingClient;
  readonly runtime: ReturnType<typeof createStudyAIRuntime>;
}): Promise<{
  readonly outcomes: readonly TopicMergeOutcome[];
  readonly created: number;
  /** topicKey → the id of the topic a create produced. Empty for pure updates. Used by the
   *  resumable path to write a create's id back into the frozen plan so a later run resolves
   *  it to a skip rather than a duplicate. */
  readonly createdTopicIds: ReadonlyMap<string, string>;
}> {
  const outcomes: TopicMergeOutcome[] = [];
  const createdTopicIds = new Map<string, string>();
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
      const perTopic = await verifyMerge({
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

      // Document-level backstop findings ride the same durable channel as the per-topic
      // ones: `needs_review` and `review_notes` on the revision row this persist writes.
      // Applied here rather than inside `verifyMerge` because they are not the merge's
      // fault and a re-merge cannot fix them — they must flag, and never spend a call.
      const verified: VerifiedMerge =
        input.backstopFindings.length === 0
          ? perTopic
          : {
              ...perTopic,
              needsReview: true,
              findings: [...perTopic.findings, ...input.backstopFindings],
            };

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

      const { topicId, slug } = await persistTopicMerge({
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
        createdTopicIds.set(target.topicKey, topicId);
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

  return { outcomes, created, createdTopicIds };
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

  // ── The hard invariant: every segment reaches a merge target ──────────────
  //
  // Not a threshold and not a ratio. Segmentation decided what this document is made of, and
  // anything that does not arrive here is content the student uploaded and will never see.
  // Wave 4 shipped 1 of 48 with `trustworthy: true` and no warning anywhere, so this is
  // computed and stated explicitly rather than inferred from a nearby number — note that
  // `topicsTouched` below counts TOPICS, and the segments-merged figure existed nowhere in
  // this codebase before it was added here.
  const segmentsMerged = new Set(
    targets.flatMap((target) => target.segments.map((segment) => segment.key)),
  ).size;

  await warnSegmentsNotReached(
    admin,
    { userId, documentId, courseId },
    segmentsMerged,
    routing.segments.length,
  );

  const funnelFinding = await applyFunnelBackstop(
    admin,
    { userId, documentId, courseId },
    {
      existingTopicCount: existingTopics.length,
      segmentsMerged,
      mergeTargetCount: targets.length,
    },
  );

  // ── Convergence gate (PLAN §5's "Idempotency & re-processing") ─────────────
  //
  // Everything above this line is cheap and deterministic enough to repeat. Everything below
  // it costs a Sonnet merge plus a Gemini critic per topic (~$0.06) and moves `topics
  // .revision`, so a second pass over a topic this document already merged into must not
  // reach it. `planMergeWork` is pure and lives in `@study/core`; the database enforces the
  // same rule independently via `topic_revisions_one_merge_per_document`, because the writer
  // here holds the service key and RLS is not in its path.
  //
  // ⚠ This is NOT PLAN §5's strip. The strip — replay each topic forward from its pre-merge
  // snapshot, re-applying only other documents' revisions, then delete this document's
  // `topic_sources` rows and chunks and run fresh — remains unbuilt. A re-run converges on
  // the page it already has rather than rebuilding it from a fresh extraction. See the
  // 🔴 DISPROVEN 2026-07-20 note in PLAN §5.
  const plan = planMergeWork({
    targets,
    priorContributions: await loadPriorContributions(admin, userId, documentId),
  });

  const skippedOutcomes: TopicMergeOutcome[] = [];
  for (const skipped of plan.skipped) {
    if (skipped.provenanceMissing) {
      await repairProvenance({
        admin,
        userId,
        documentId,
        skipped,
        segments: targets.find((t) => t.topicKey === skipped.topicKey)?.segments ?? [],
      });
    }

    await logProcessingEvent(admin, {
      userId,
      documentId,
      courseId,
      step: `merge:topic:${skipped.topicKey}`,
      detail: `“${skipped.title}” already includes this file — left as it is.`,
    });

    // Counted as merged, because it is: this document's material is in that page. The
    // outcome feeds `computeDocumentOutcome`, and reporting a skip as anything else would
    // turn a converged retry into a `failed` document. `needsReview` is false rather than
    // carried forward from the original merge — the flag belongs to the revision that raised
    // it and is still on it; nothing was reviewed *this* run.
    skippedOutcomes.push({ topicKey: skipped.topicKey, status: "merged", needsReview: false });
  }

  if (plan.skipped.length > 0) {
    await logProcessingEvent(admin, {
      userId,
      documentId,
      courseId,
      step: "merge",
      detail: `${plan.skipped.length} topic${plan.skipped.length === 1 ? " was" : "s were"} already updated from this file on an earlier run; picking up where it stopped.`,
    });
  }

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
    targets: plan.toMerge,
    unaccountedPages: routing.unaccountedPages,
    coverageChecked: routing.coverageChecked,
    backstopFindings: funnelFinding === null ? [] : [funnelFinding],
    takenSlugs,
    embeddings,
    runtime,
  });

  const topicOutcomes = [...skippedOutcomes, ...outcomes];
  const outcome = computeDocumentOutcome({ topicOutcomes });

  return {
    outcome,
    topicOutcomes,
    segments: routing.segments.length,
    segmentsMerged,
    topicsTouched: targets.length,
    topicsCreated: created,
    coercions: routing.coercions.length,
    singletonFolds: routing.folds.length,
    unaccountedPages: routing.unaccountedPages.length,
    costUsd: await mergeCost(admin, userId, documentId),
    elapsedMs: Date.now() - startedAt,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Shared feed warnings (single-step AND resumable paths use these)           */
/* ────────────────────────────────────────────────────────────────────────── */

interface FeedContext {
  readonly userId: string;
  readonly documentId: string;
  readonly courseId: string;
}

/**
 * The hard invariant's voice: content the student uploaded that reached no topic.
 *
 * Extracted into one function so {@link runRouteAndMerge} (single-step) and
 * {@link resolveMergePlan} (resumable) emit byte-identical text — a warn with two spellings
 * would be a channel-destroying drift, and this one is pinned by a test.
 */
async function warnSegmentsNotReached(
  admin: SupabaseAdminClient,
  ctx: FeedContext,
  segmentsMerged: number,
  totalSegments: number,
): Promise<void> {
  if (segmentsMerged === totalSegments) return;
  const lost = totalSegments - segmentsMerged;
  await logProcessingEvent(admin, {
    userId: ctx.userId,
    documentId: ctx.documentId,
    courseId: ctx.courseId,
    step: "route",
    level: "warn",
    detail: `${segmentsMerged} of ${totalSegments} sections of this file reached a topic. ${lost} ${lost === 1 ? "section" : "sections"} did not, and ${lost === 1 ? "its" : "their"} content is not in your notes.`,
  });
}

/**
 * The single-topic funnel backstop (Wave 6): detect, warn if it fires, return the finding so
 * it can ride every persisted revision. Deterministic and downstream of the prompt, the
 * resolver and the guard — it flags the created topic's first revision, never blocks a merge.
 */
async function applyFunnelBackstop(
  admin: SupabaseAdminClient,
  ctx: FeedContext,
  counts: {
    readonly existingTopicCount: number;
    readonly segmentsMerged: number;
    readonly mergeTargetCount: number;
  },
): Promise<string | null> {
  const finding = detectSingleTopicFunnel({
    existingTopicCount: counts.existingTopicCount,
    routedSegmentCount: counts.segmentsMerged,
    mergeTargetCount: counts.mergeTargetCount,
  });
  if (finding !== null) {
    await logProcessingEvent(admin, {
      userId: ctx.userId,
      documentId: ctx.documentId,
      courseId: ctx.courseId,
      step: "route",
      level: "warn",
      detail: `All ${counts.segmentsMerged} sections of this file were funnelled into a single topic on a course with no topics yet — the page was saved, but flagged for review as likely under-split.`,
    });
  }
  return finding;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* §3 resumable path: frozen plan + one memoized step per merge target        */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * A minimal Inngest `step.run`. Structural, so the real Inngest step, an inline runner, and
 * the test's memoizing fake all satisfy it. The contract that matters: a completed `id` is
 * memoized within a run, so a retry does not re-execute it.
 */
export interface StepRunner {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

/** The topic-routing prompt version the plan key is scoped by (5 today). Read from the
 *  registry so a router bump takes a fresh plan rather than reusing an older one's. */
const ROUTING_PROMPT_VERSION = topicRoutingPrompt.version;

/** One resolved merge target in the frozen plan. Segment CONTENT is NOT stored — it is
 *  re-derived deterministically from the (extraction-hash-pinned) extraction by segment key. */
const plannedTargetSchema = z.object({
  /** Stable id for the per-target step, so a retry memoizes a completed target. */
  topicKey: z.string(),
  /** The existing topic this assigns to; null for a create. */
  topicId: z.string().nullable(),
  title: z.string(),
  /** Which segments feed this target — the join keys back into `segmentExtraction`. */
  segmentKeys: z.array(z.string()),
  /** Written back after a create persists, so a later run resolves it to a skip. */
  resolvedTopicId: z.string().optional(),
});

/** The frozen plan, `safeParse`d on the way out of `document_merge_plans.plan` (boundary
 *  rule): a plan written by an older shape of this schema is an external input like any
 *  other, and one that no longer parses is treated as absent so routing recomputes it. */
const storedMergePlanSchema = z.object({
  version: z.literal(1),
  targets: z.array(plannedTargetSchema),
  unaccountedPages: z.array(z.number()),
  coverageChecked: z.boolean(),
  backstopFindings: z.array(z.string()),
  segments: z.number(),
  segmentsMerged: z.number(),
  topicsTouched: z.number(),
  coercions: z.number(),
  singletonFolds: z.number(),
});

type PlannedTarget = z.infer<typeof plannedTargetSchema>;
type StoredMergePlan = z.infer<typeof storedMergePlanSchema>;

/** Reads and validates `documents.extraction` through the schema, never a cast. */
async function readStoredExtraction(
  admin: SupabaseAdminClient,
  userId: string,
  documentId: string,
): Promise<z.infer<typeof storedExtractionSchema>> {
  const { data, error } = await admin
    .from("documents")
    .select("extraction")
    .eq("id", documentId)
    .eq("user_id", userId)
    .single();
  if (error) throw new Error(`Could not read the extraction for ${documentId}: ${error.message}`);
  const parsed = storedExtractionSchema.safeParse(data.extraction);
  if (!parsed.success) {
    throw new Error(
      `documents.extraction for ${documentId} did not match storedExtractionSchema: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** The document's routable segments — deterministic in the extraction, so re-deriving them
 *  on a retry reproduces the exact segment keys the frozen plan refers to. */
function segmentsOf(stored: z.infer<typeof storedExtractionSchema>): readonly Segment[] {
  return segmentExtraction({
    pages: stored.extraction.pages,
    headings: stored.extraction.headings,
    skipped: stored.extraction.skipped,
    sourceUnits: stored.sourceUnits,
  }).segments;
}

/** Loads one topic's page + revision, fresh, for a per-target step. Null when it is gone. */
async function loadOneTopic(
  admin: SupabaseAdminClient,
  userId: string,
  topicId: string,
): Promise<{ id: string; title: string; page: StoredTopicPage; revision: number } | null> {
  const { data, error } = await admin
    .from("topics")
    .select("id, title, page, revision")
    .eq("id", topicId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`Could not load topic ${topicId}: ${error.message}`);
  if (data === null) return null;
  const parsedPage = storedTopicPageSchema.safeParse(data.page);
  return {
    id: data.id,
    title: data.title,
    page: parsedPage.success ? parsedPage.data : EMPTY_TOPIC_PAGE,
    revision: data.revision,
  };
}

/** The current `document_merge_plans.plan` for a document, or null when there is none. */
async function loadFrozenPlan(
  admin: SupabaseAdminClient,
  userId: string,
  documentId: string,
  hash: string,
): Promise<StoredMergePlan | null> {
  const { data, error } = await admin
    .from("document_merge_plans")
    .select("plan")
    .eq("user_id", userId)
    .eq("document_id", documentId)
    .eq("extraction_hash", hash)
    .eq("prompt_version", ROUTING_PROMPT_VERSION)
    .maybeSingle();
  if (error) throw new Error(`Could not read the merge plan for ${documentId}: ${error.message}`);
  if (data?.plan == null) return null;
  const parsed = storedMergePlanSchema.safeParse(data.plan);
  if (!parsed.success) {
    // A plan written by an older shape of the schema is treated as absent — recompute rather
    // than resume from something this code can no longer read.
    console.error(`[route-and-merge] frozen plan for ${documentId} did not parse; recomputing`);
    return null;
  }
  return parsed.data;
}

/**
 * Records the topic id a create produced back into the frozen plan.
 *
 * This is the cross-run create-idempotency link. A create target carries no `topicId` in the
 * plan, so `planMergeWork` can never skip it — on a *new* run (the "Retry the rest" button, a
 * fresh Inngest run where step memoization does not carry over) a create would run again and
 * duplicate the topic. Stamping the resulting id here turns that create into an assign the
 * next run resolves to a skip. Safe as a read-modify-write because `process-document` is
 * serialized per course.
 */
async function recordResolvedCreate(
  admin: SupabaseAdminClient,
  userId: string,
  documentId: string,
  hash: string,
  topicKey: string,
  topicId: string,
): Promise<void> {
  const plan = await loadFrozenPlan(admin, userId, documentId, hash);
  if (plan === null) return;
  const patched: StoredMergePlan = {
    ...plan,
    targets: plan.targets.map((target) =>
      target.topicKey === topicKey ? { ...target, resolvedTopicId: topicId } : target,
    ),
  };
  const { error } = await admin
    .from("document_merge_plans")
    .update({ plan: patched })
    .eq("user_id", userId)
    .eq("document_id", documentId)
    .eq("extraction_hash", hash)
    .eq("prompt_version", ROUTING_PROMPT_VERSION);
  if (error) {
    // The write-back is a convergence optimisation, not a correctness invariant (the DB
    // trigger is), so a failure here is logged rather than allowed to fail the topic.
    console.error(`[route-and-merge] could not record resolved create for ${topicKey}:`, error);
  }
}

/**
 * The `resolve-merge-plan` step: LOAD the frozen plan if one exists (zero routing), else
 * route + guard + coalesce and UPSERT the resolved plan.
 *
 * This is the durable frozen receipt that stops the §3 data loss: a re-entering run reads the
 * SAME plan the first pass resolved on an empty index, instead of re-routing 48 segments into
 * a half-built 4-topic index and abandoning the 4 targets that never got created. The plan is
 * keyed on {@link extractionHash} — index-INDEPENDENT — not the routing `input_hash`, which
 * changes between passes precisely because the index changed.
 */
async function resolveMergePlan(input: {
  readonly admin: SupabaseAdminClient;
  readonly userId: string;
  readonly documentId: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly filename: string;
  readonly sessionLabel: string | null;
  readonly embeddings: EmbeddingClient;
  readonly runtime: ReturnType<typeof createStudyAIRuntime>;
}): Promise<{ readonly plan: StoredMergePlan; readonly extractionHash: string }> {
  const { admin, userId, documentId, courseId } = input;

  await setDocumentStatus(admin, documentId, userId, { status: "merging" });

  // The index-INDEPENDENT identity of this document's extraction.
  const { data: docRow, error: docError } = await admin
    .from("documents")
    .select("extraction")
    .eq("id", documentId)
    .eq("user_id", userId)
    .single();
  if (docError) throw new Error(`Could not read ${documentId} for hashing: ${docError.message}`);
  const hash = await extractionHash(docRow.extraction);

  // ── Frozen receipt: LOAD and route zero times ─────────────────────────────
  const existingPlan = await loadFrozenPlan(admin, userId, documentId, hash);
  if (existingPlan !== null) {
    await logProcessingEvent(admin, {
      userId,
      documentId,
      courseId,
      step: "route",
      detail: "Re-using the plan worked out on an earlier attempt — picking up where it stopped.",
    });
    return { plan: existingPlan, extractionHash: hash };
  }

  // ── Compute: route + guard + coalesce, then freeze ────────────────────────
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
    embeddings: input.embeddings,
    runtime: input.runtime,
  });

  const targets = planMerges(routing.routed, routing.segments, existingTopics);
  const segmentsMerged = new Set(
    targets.flatMap((target) => target.segments.map((segment) => segment.key)),
  ).size;

  const ctx: FeedContext = { userId, documentId, courseId };
  await warnSegmentsNotReached(admin, ctx, segmentsMerged, routing.segments.length);
  const funnelFinding = await applyFunnelBackstop(admin, ctx, {
    existingTopicCount: existingTopics.length,
    segmentsMerged,
    mergeTargetCount: targets.length,
  });

  const plan: StoredMergePlan = {
    version: 1,
    targets: targets.map((target) => ({
      topicKey: target.topicKey,
      topicId: target.topicId,
      title: target.title,
      segmentKeys: target.segments.map((segment) => segment.key),
    })),
    unaccountedPages: [...routing.unaccountedPages],
    coverageChecked: routing.coverageChecked,
    backstopFindings: funnelFinding === null ? [] : [funnelFinding],
    segments: routing.segments.length,
    segmentsMerged,
    topicsTouched: targets.length,
    coercions: routing.coercions.length,
    singletonFolds: routing.folds.length,
  };

  const { error: upsertError } = await admin.from("document_merge_plans").upsert(
    {
      user_id: userId,
      document_id: documentId,
      extraction_hash: hash,
      prompt_version: ROUTING_PROMPT_VERSION,
      plan,
    },
    { onConflict: "document_id,extraction_hash,prompt_version" },
  );
  if (upsertError) {
    throw new Error(`Could not persist the merge plan for ${documentId}: ${upsertError.message}`);
  }

  return { plan, extractionHash: hash };
}

/**
 * One `merge-target:<stableKey>` step: finish exactly one target of the frozen plan.
 *
 * Self-contained on purpose — it re-derives its segments from the extraction, re-reads its
 * topic's current page + revision, and re-runs `planMergeWork` as a backstop — so Inngest can
 * run it in isolation and a retry that lands here touches only this target. A create's
 * resulting id is written back to the plan so a later run resolves it to a skip.
 */
async function runMergeTarget(input: {
  readonly admin: SupabaseAdminClient;
  readonly userId: string;
  readonly documentId: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly filename: string;
  readonly sessionLabel: string | null;
  readonly planned: PlannedTarget;
  readonly extractionHash: string;
  readonly backstopFindings: readonly string[];
  readonly unaccountedPages: readonly number[];
  readonly coverageChecked: boolean;
  readonly embeddings: EmbeddingClient;
  readonly runtime: ReturnType<typeof createStudyAIRuntime>;
}): Promise<{ readonly outcome: TopicMergeOutcome; readonly created: boolean }> {
  const { admin, userId, documentId, courseId, planned } = input;

  const noop = (): { outcome: TopicMergeOutcome; created: boolean } => ({
    outcome: { topicKey: planned.topicKey, status: "merged", needsReview: false },
    created: false,
  });

  // Re-derive this target's segments from the (hash-pinned) extraction.
  const stored = await readStoredExtraction(admin, userId, documentId);
  const byKey = new Map(segmentsOf(stored).map((segment) => [segment.key, segment]));
  const segments = planned.segmentKeys
    .map((key) => byKey.get(key))
    .filter((segment): segment is Segment => segment !== undefined)
    .sort((a, b) => a.fromPage - b.fromPage);
  // No segments means the extraction changed shape under a matching hash (should not happen);
  // there is nothing to merge, so this is a clean no-op rather than a failure.
  if (segments.length === 0) return noop();

  // Cross-run create idempotency: a create completed on a PRIOR run stamped its id into the
  // plan. Reading it fresh (not from the possibly-stale in-memory plan) makes this step
  // resolve that create to an assign even when it re-runs without memoization.
  const frozen = await loadFrozenPlan(admin, userId, documentId, input.extractionHash);
  const resolvedTopicId =
    frozen?.targets.find((target) => target.topicKey === planned.topicKey)?.resolvedTopicId ??
    planned.resolvedTopicId ??
    null;
  const effectiveTopicId = resolvedTopicId ?? planned.topicId;

  // Build the concrete MergeTarget with FRESH topic state.
  let target: MergeTarget;
  if (effectiveTopicId !== null) {
    const topic = await loadOneTopic(admin, userId, effectiveTopicId);
    target =
      topic === null
        ? // The topic the plan named is gone. Recreate under the SAME stable key rather than
          // writing into a vanished id.
          {
            topicId: null,
            topicKey: planned.topicKey,
            title: planned.title,
            current: EMPTY_TOPIC_PAGE,
            currentRevision: 0,
            segments,
          }
        : {
            topicId: topic.id,
            topicKey: planned.topicKey,
            title: topic.title,
            current: topic.page,
            currentRevision: topic.revision,
            segments,
          };
  } else {
    target = {
      topicId: null,
      topicKey: planned.topicKey,
      title: planned.title,
      current: EMPTY_TOPIC_PAGE,
      currentRevision: 0,
      segments,
    };
  }

  // Convergence backstop — no longer the PRIMARY resume mechanism (the frozen plan is), but
  // still the guard that skips a target this document already merged.
  const priorContributions = await loadPriorContributions(admin, userId, documentId);
  const { toMerge, skipped } = planMergeWork({ targets: [target], priorContributions });

  const skippedTarget = skipped[0];
  if (skippedTarget !== undefined) {
    if (skippedTarget.provenanceMissing) {
      await repairProvenance({ admin, userId, documentId, skipped: skippedTarget, segments });
    }
    await logProcessingEvent(admin, {
      userId,
      documentId,
      courseId,
      step: `merge:topic:${skippedTarget.topicKey}`,
      detail: `“${skippedTarget.title}” already includes this file — left as it is.`,
    });
    return noop();
  }
  if (toMerge.length === 0) return noop();

  // takenSlugs fresh from the DB, so a create lands a slug unique against the topics earlier
  // targets of THIS document already committed.
  const { data: slugRows } = await admin
    .from("topics")
    .select("slug")
    .eq("user_id", userId)
    .eq("course_id", courseId);
  const takenSlugs = new Set((slugRows ?? []).map((row) => row.slug));

  const { outcomes, created, createdTopicIds } = await mergeTopics({
    admin,
    userId,
    documentId,
    courseId,
    courseTitle: input.courseTitle,
    filename: input.filename,
    sessionLabel: input.sessionLabel,
    targets: toMerge,
    unaccountedPages: input.unaccountedPages,
    coverageChecked: input.coverageChecked,
    backstopFindings: input.backstopFindings,
    takenSlugs,
    embeddings: input.embeddings,
    runtime: input.runtime,
  });

  const newTopicId = createdTopicIds.get(planned.topicKey);
  if (newTopicId !== undefined) {
    await recordResolvedCreate(
      admin,
      userId,
      documentId,
      input.extractionHash,
      planned.topicKey,
      newTopicId,
    );
  }

  const outcome = outcomes[0] ?? {
    topicKey: planned.topicKey,
    status: "failed" as const,
    error: "merge produced no outcome",
  };
  return { outcome, created: created > 0 };
}

/**
 * §5 Steps A–C as a RESUMABLE sequence of Inngest steps (Wave 7 §3).
 *
 * Replaces the single `step.run("route-and-merge")` that ran routing + every merge as one
 * step — the exposure that lost 4 topics on the failing production run. Here the routing is
 * frozen into `document_merge_plans` by `resolve-merge-plan`, and each merge target is its own
 * `merge-target:<stableKey>` step, so a retry LOADS the plan (zero routing) and Inngest
 * memoizes the targets that already persisted — a kill inside target 5 of 8 resumes at 5,
 * never re-routing and never re-running 1–4.
 *
 * Isolation (PLAN §7's `partial`) still comes from the per-topic `try` in {@link mergeTopics};
 * the per-target step boundary adds resumability on top of it.
 */
export async function runRouteAndMergeSteps(
  input: RouteAndMergeInput & { readonly step: StepRunner },
): Promise<RouteAndMergeSummary> {
  const { admin, userId, documentId, courseId, step } = input;
  const startedAt = Date.now();
  const runtime = createStudyAIRuntime({ userId });
  const embeddings = createStudyEmbeddingClient({ userId });

  const { plan, extractionHash: hash } = await step.run("resolve-merge-plan", () =>
    resolveMergePlan({
      admin,
      userId,
      documentId,
      courseId,
      courseTitle: input.courseTitle,
      filename: input.filename,
      sessionLabel: input.sessionLabel,
      embeddings,
      runtime,
    }),
  );

  const topicOutcomes: TopicMergeOutcome[] = [];
  let created = 0;
  for (const planned of plan.targets) {
    const result = await step.run(`merge-target:${planned.topicKey}`, () =>
      runMergeTarget({
        admin,
        userId,
        documentId,
        courseId,
        courseTitle: input.courseTitle,
        filename: input.filename,
        sessionLabel: input.sessionLabel,
        planned,
        extractionHash: hash,
        backstopFindings: plan.backstopFindings,
        unaccountedPages: plan.unaccountedPages,
        coverageChecked: plan.coverageChecked,
        embeddings,
        runtime,
      }),
    );
    topicOutcomes.push(result.outcome);
    if (result.created) created += 1;
  }

  const outcome = computeDocumentOutcome({ topicOutcomes });

  return {
    outcome,
    topicOutcomes,
    segments: plan.segments,
    segmentsMerged: plan.segmentsMerged,
    topicsTouched: plan.topicsTouched,
    topicsCreated: created,
    coercions: plan.coercions,
    singletonFolds: plan.singletonFolds,
    unaccountedPages: plan.unaccountedPages.length,
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
