/**
 * Recomputing a course's `topics.exam_weight` after a merge (PLAN §9: *"Weights recompute
 * after every merge; stored on `topics.exam_weight`"*).
 *
 * This is the pipeline side of the pure `computeExamWeight` / `mapExamSignals` blend in
 * `@study/core`. It gathers what those functions need from already-persisted rows — the course's
 * topics, their `topic_sources` page-ranges, the instructor `examSignals` sitting in each
 * `documents.extraction`, and the artifact counts on each topic page — runs the blend, and
 * writes the result back.
 *
 * ## What it must never touch, and why it writes the pure blend
 *
 * `exam_weight` is the **computed** column; `exam_weight_override` is the user's, and it wins at
 * READ time (`override ?? exam_weight`, as `topic-list`/`topic-view`/`generate-review` all
 * read it). So this writer computes the blend with `override: null` and writes THAT — the value
 * the material implies — and never reads or writes the override column. Folding the override
 * into `exam_weight` would collapse the two into one number and leave a stale value behind the
 * moment the user cleared their override; keeping them separate is what §9(d) actually needs.
 *
 * ## Why it recomputes the WHOLE course, not just the touched topics
 *
 * A new upload changes two things for topics it never merged into: the course's recency
 * baseline shifts (older topics become comparatively staler), and a signal on a new slide can
 * map — by fuzzy fallback — to an existing topic. So the weight of an untouched topic can
 * legitimately move, and recomputing only the merged ones would leave the ordering wrong.
 *
 * ## Why it never marks reviews stale
 *
 * It writes `exam_weight`, which bumps `updated_at` but NOT `revision`. `mark-reviews-stale`
 * compares revisions, so a pure weight recompute leaves review staleness untouched — which is
 * correct: reordering revision priorities is not the same as changing the material a review was
 * built from.
 */

import { storedExtractionSchema, storedTopicPageSchema } from "@study/ai";
import {
  computeExamWeight,
  countSignalsByTopic,
  type MappableSignal,
  type MappableTopic,
  mapExamSignals,
} from "@study/core";
import type { SupabaseAdminClient } from "@study/db";
import { z } from "zod";

/** `topic_sources.locators` is `[{page:12},{slide:4}]`; both are "the nth unit" for matching. */
const locatorsSchema = z
  .array(z.object({ page: z.number().int().optional(), slide: z.number().int().optional() }))
  .catch([]);

/** The page/slide numbers a `locators` jsonb value covers. */
function locatorPages(value: unknown): number[] {
  const parsed = locatorsSchema.safeParse(value);
  if (!parsed.success) return [];
  const pages: number[] = [];
  for (const locator of parsed.data) {
    if (typeof locator.page === "number") pages.push(locator.page);
    else if (typeof locator.slide === "number") pages.push(locator.slide);
  }
  return pages;
}

/**
 * Recency of each topic's newest source, normalised to `[0, 1]`.
 *
 * The course's documents are ordered oldest→newest and given evenly-spaced positions, so a
 * topic fed only by the first upload scores 0 (stale) and one fed by the latest scores 1
 * (fresh). A single-document course has no "older" to be stale against, so every topic in it is
 * treated as current — `1`.
 */
function recencyByDocument(
  documents: readonly { id: string; created_at: string }[],
): ReadonlyMap<string, number> {
  const ordered = [...documents].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const denominator = ordered.length - 1;
  const recency = new Map<string, number>();
  ordered.forEach((document, index) => {
    recency.set(document.id, denominator <= 0 ? 1 : index / denominator);
  });
  return recency;
}

export interface RecomputeExamWeightsInput {
  readonly admin: SupabaseAdminClient;
  readonly userId: string;
  readonly courseId: string;
}

export interface RecomputeExamWeightsResult {
  readonly topicsConsidered: number;
  readonly topicsWritten: number;
  readonly signalsMapped: number;
}

/** Recomputes and persists `topics.exam_weight` for every topic of a course. */
export async function recomputeExamWeights(
  input: RecomputeExamWeightsInput,
): Promise<RecomputeExamWeightsResult> {
  const { admin, userId, courseId } = input;

  const [{ data: topicRows, error: topicError }, { data: docRows, error: docError }] =
    await Promise.all([
      admin
        .from("topics")
        .select("id, title, summary, page, exam_weight")
        .eq("user_id", userId)
        .eq("course_id", courseId),
      admin
        .from("documents")
        .select("id, extraction, created_at")
        .eq("user_id", userId)
        .eq("course_id", courseId),
    ]);

  if (topicError !== null) {
    throw new Error(`Could not load topics for course ${courseId}: ${topicError.message}`);
  }
  if (docError !== null) {
    throw new Error(`Could not load documents for course ${courseId}: ${docError.message}`);
  }

  const topics = topicRows ?? [];
  if (topics.length === 0) {
    return { topicsConsidered: 0, topicsWritten: 0, signalsMapped: 0 };
  }

  // ── topic_sources: which document/pages fed each topic ──────────────────────
  const { data: sourceRows, error: sourceError } = await admin
    .from("topic_sources")
    .select("topic_id, document_id, locators")
    .eq("user_id", userId)
    .in(
      "topic_id",
      topics.map((topic) => topic.id),
    );
  if (sourceError !== null) {
    throw new Error(`Could not load topic sources for course ${courseId}: ${sourceError.message}`);
  }

  const sourcesByTopic = new Map<string, { documentId: string; pages: number[] }[]>();
  for (const row of sourceRows ?? []) {
    const list = sourcesByTopic.get(row.topic_id) ?? [];
    list.push({ documentId: row.document_id, pages: locatorPages(row.locators) });
    sourcesByTopic.set(row.topic_id, list);
  }

  // ── examSignals harvested from each document's stored extraction ─────────────
  const signals: MappableSignal[] = [];
  for (const doc of docRows ?? []) {
    const parsed = storedExtractionSchema.safeParse(doc.extraction);
    if (!parsed.success) continue; // a document not yet extracted contributes no signals
    for (const signal of parsed.data.extraction.examSignals) {
      signals.push({
        quote: signal.quote,
        page: signal.page,
        label: signal.topic,
        documentId: doc.id,
      });
    }
  }

  // ── G2: map each signal to a topic, then count per topic ─────────────────────
  const mappableTopics: MappableTopic[] = topics.map((topic) => ({
    topicId: topic.id,
    title: topic.title,
    summary: topic.summary,
    sources: sourcesByTopic.get(topic.id) ?? [],
  }));
  const mappings = mapExamSignals(signals, mappableTopics);
  const signalCounts = countSignalsByTopic(mappings);
  const signalsMapped = mappings.filter((mapping) => mapping.topicId !== null).length;

  const recency = recencyByDocument(docRows ?? []);

  // ── G1: blend, then write the computed column (never the override) ───────────
  let topicsWritten = 0;
  await Promise.all(
    topics.map(async (topic) => {
      const page = storedTopicPageSchema.safeParse(topic.page);
      const formulaCount = page.success ? page.data.formulas.length : 0;
      const workedExampleCount = page.success ? page.data.workedExamples.length : 0;

      const sources = sourcesByTopic.get(topic.id) ?? [];
      const recencyFactor = sources.reduce(
        (best, source) => Math.max(best, recency.get(source.documentId) ?? 0),
        0,
      );

      const weight = computeExamWeight({
        // The pure blend — NOT the effective weight. `exam_weight` is the computed column and
        // the override wins at read time, so folding the override in here would be wrong (see
        // the header). This writer never reads or writes the override.
        override: null,
        signalCount: signalCounts.get(topic.id) ?? 0,
        sourceCount: sources.length,
        recencyFactor,
        formulaCount,
        workedExampleCount,
      });

      // Skip a write that would not change the stored value — a `real` round-trips at ~7
      // digits, so anything inside 1e-4 is noise, and skipping it avoids a pointless
      // `updated_at` bump on an untouched topic.
      if (Math.abs(weight - topic.exam_weight) < 1e-4) return;

      const { error } = await admin
        .from("topics")
        .update({ exam_weight: weight })
        .eq("id", topic.id)
        .eq("user_id", userId);
      if (error !== null) {
        // One topic failing to write must not lose the rest — weights are advisory, and the
        // next merge recomputes them anyway.
        console.error(`[exam-weights] could not write weight for topic ${topic.id}:`, error);
        return;
      }
      topicsWritten += 1;
    }),
  );

  return { topicsConsidered: topics.length, topicsWritten, signalsMapped };
}
