/**
 * The deterministic duplicate guard (PLAN §5 Step A.4) — **code, not LLM**.
 *
 * The routing model is asked to pick an existing topic or justify a new one, and it is
 * prompted to prefer picking. It still drifts: "Neural Networks" today, "Neural Nets —
 * Intro" three weeks later, both plausible, neither obviously a duplicate from inside a
 * single call that sees one document. The result is the exact failure the product invariant
 * forbids — a course whose topic set stops being a stable index and starts being a pile of
 * near-synonyms.
 *
 * So the LLM's `createNew` is a **proposal**, and this function is the adjudicator: every
 * proposed title is embedded and compared against existing topic titles by cosine, and
 * anything at or above {@link DUPLICATE_TITLE_THRESHOLD} is coerced into an assignment to
 * the nearest topic. It is exact, free, and runs on every routing decision.
 *
 * ## Two directions of drift — and only ONE of them gets the cosine (Wave 6)
 *
 * PLAN's sentence "proposed-new titles within the same document are also cross-checked
 * against each other" is a second, separate guard, and since Wave 6 it uses a different —
 * far stricter — notion of "duplicate" than the first, because the two guards see two
 * different situations:
 *
 * - **Cross-upload (guard 1): cosine ≥ {@link DUPLICATE_TITLE_THRESHOLD}.** Two routing
 *   calls weeks apart cannot see each other's titles, so "Neural Networks" vs "Neural Nets —
 *   Intro" is an *accident* of phrasing, and semantic similarity is the right test for it.
 *   Its failure mode — duplicate topics proliferating across uploads — is the exact thing
 *   the threshold exists to stop. Unchanged.
 *
 * - **Same-batch (guard 2): normalised title IDENTITY, cosine-free.** The router saw every
 *   segment of the document in ONE call. When it still gives two segments different titles,
 *   that is a *deliberate distinction*, not drift — and overriding it re-merges what the
 *   model split. Measured on the real Wave 4 deck: the router proposed 7 legitimately
 *   distinct statistics topics, and the cosine fold collapsed them to 2, because "Chi-Square
 *   Distribution" is 0.862-similar to "Sampling Distributions" *as a title* while being a
 *   different concept. Names in one field are similar because the field names them
 *   similarly. So guard 2 folds only spelling variants of the SAME title (the
 *   `normaliseTitle` semantics shared with `resolveRoutingDecisions`) — which is also the
 *   normal batch-local shape, where 40 segments name the topic the batch is creating.
 *
 * The two outcomes are deliberately different and are reported separately:
 * - collision with an **existing** topic → `coerced-to-existing`, the segment is routed to a
 *   real `topicId`, and the create disappears.
 * - the same title **earlier in the same document** → `merged-into-proposal`, both segments
 *   end up on the *same* new topic, which is still created.
 *
 * Nothing here does I/O and nothing here calls a model. The caller supplies the vectors —
 * and guard 2 no longer needs one, so identical titles fold even when embedding failed.
 */

import { normaliseTitle } from "./route-decisions";

/**
 * Cosine similarity of two vectors, or `null` when they cannot be compared.
 *
 * `null` rather than 0 for a length mismatch or a zero vector, and the distinction matters:
 * 0 means "measured, and they are unrelated", which the guard reads as "safe to create a
 * new topic". A dimension mismatch is not evidence of unrelatedness — it is evidence that
 * something upstream is wrong (two embedding models mixed, a truncated vector read back
 * from the database) — and silently reporting it as 0 would turn a broken retrieval into a
 * stream of confidently-created duplicate topics.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number | null {
  if (a.length === 0 || a.length !== b.length) return null;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return null;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  if (normA === 0 || normB === 0) return null;
  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  // Floating-point error can push a self-comparison to 1.0000000000000002, which reads
  // badly in a log line and in a test. Clamp to the mathematically valid range.
  return Math.min(1, Math.max(-1, similarity));
}

/**
 * The coercion threshold (PLAN §5 Step A.4, quoted: "Cosine similarity ≥ 0.85").
 *
 * Deliberately a named constant rather than a parameter with a default: it is a product
 * decision about how aggressively the topic index is kept flat, and a call site that could
 * quietly pass 0.6 would be a call site that could quietly stop the guard from firing.
 */
export const DUPLICATE_TITLE_THRESHOLD = 0.85;

/** An existing topic, as the guard needs to see it. */
export interface ExistingTopicTitle {
  readonly id: string;
  readonly title: string;
  /** `topics.title_embedding`. A topic whose vector was never written is skipped. */
  readonly titleEmbedding: readonly number[] | null;
}

/** One routing proposal from the `topic-routing` call, after schema validation. */
export type RoutingProposal =
  | { readonly segmentKey: string; readonly kind: "assign"; readonly topicId: string }
  | {
      readonly segmentKey: string;
      readonly kind: "create";
      readonly title: string;
      readonly rationale: string;
      /**
       * The proposed title's embedding. `null` leaves guard 1 (the cross-upload cosine)
       * unable to run — reported, not swallowed. Guard 2 is title-based and runs regardless.
       */
      readonly titleEmbedding: readonly number[] | null;
    };

/** What a segment is finally routed to, after the guard has had its say. */
export type RoutedSegment =
  | { readonly segmentKey: string; readonly kind: "assign"; readonly topicId: string }
  | {
      readonly segmentKey: string;
      readonly kind: "create";
      /** Groups every segment routed to the same new topic. Stable within one document. */
      readonly proposalKey: string;
      readonly title: string;
      readonly rationale: string;
    };

export type CoercionReason = "coerced-to-existing" | "merged-into-proposal";

/**
 * One thing the guard changed. Every entry becomes a processing event: `coerced-to-existing`
 * at `warn` (the guard overrode the router), `merged-into-proposal` at `info` (identical
 * titles grouping onto one create is the normal batch shape, and 46 warns per upload teach
 * the reader to ignore the channel).
 */
export interface DuplicateCoercion {
  readonly segmentKey: string;
  readonly reason: CoercionReason;
  readonly proposedTitle: string;
  /** The title it collided with — an existing topic's, or an earlier proposal's. */
  readonly matchedTitle: string;
  /** Present only for `coerced-to-existing`. */
  readonly topicId?: string;
  /** The measured cosine for `coerced-to-existing`; exactly 1 for a title-identity fold. */
  readonly similarity: number;
}

/**
 * A proposal the guard could not check, and therefore let through unguarded.
 *
 * Reported rather than swallowed. An unembeddable title is exactly the case where a
 * duplicate slips into the index, and "the guard did not run on 3 of 7 proposals" is
 * something a human should be able to read in the progress feed — the alternative is a
 * guard that silently degrades to a no-op when the embedding call half-fails.
 */
export interface UnguardedProposal {
  readonly segmentKey: string;
  readonly proposedTitle: string;
  readonly reason: "no-title-embedding" | "no-comparable-existing-vectors";
}

export interface DuplicateGuardResult {
  readonly routed: readonly RoutedSegment[];
  readonly coercions: readonly DuplicateCoercion[];
  readonly unguarded: readonly UnguardedProposal[];
}

/**
 * The nearest entry in `candidates` to `vector`, above `threshold`.
 *
 * Three outcomes, not two, and conflating the last two is the subtle bug this shape exists
 * to prevent: **"nothing was close enough" and "nothing could be compared" look identical
 * to a caller that only gets `null`.** The first means the guard ran and cleared the
 * proposal; the second means the guard never ran. Reporting the second as the first is how
 * a broken embedding read turns into a silent stream of duplicate topics — the exact
 * outcome this module exists to prevent, arrived at through its own error handling.
 */
type NearestResult<T> =
  | { readonly status: "hit"; readonly candidate: T; readonly similarity: number }
  /** Comparisons ran, none reached the threshold. The proposal is genuinely novel. */
  | { readonly status: "no-match" }
  /** Not one candidate had a usable vector. Nothing was checked. */
  | { readonly status: "incomparable" };

function nearest<T extends { readonly embedding: readonly number[] | null }>(
  vector: readonly number[],
  candidates: readonly T[],
  threshold: number,
): NearestResult<T> {
  let best: { candidate: T; similarity: number } | null = null;
  let comparisons = 0;

  for (const candidate of candidates) {
    const embedding = candidate.embedding;
    if (embedding === null) continue;
    const similarity = cosineSimilarity(vector, embedding);
    if (similarity === null) continue;
    comparisons += 1;
    if (similarity >= threshold && (best === null || similarity > best.similarity)) {
      best = { candidate, similarity };
    }
  }

  if (best !== null)
    return { status: "hit", candidate: best.candidate, similarity: best.similarity };
  return comparisons === 0 ? { status: "incomparable" } : { status: "no-match" };
}

/**
 * Applies the guard to a whole document's routing decisions.
 *
 * Proposals are processed **in order**, and each accepted `create` immediately joins the
 * pool that later proposals are checked against. That ordering is what makes the
 * intra-document check work at all: it is a running fold, not a pairwise sweep, so every
 * later spelling of a title collapses onto the FIRST proposal that used it, and the
 * canonical title is stable.
 *
 * Guard 1 (cosine, against existing topics) runs before guard 2 (title identity, within
 * the batch): an existing topic must win over a same-batch proposal, because merging into
 * a proposal when a real topic already carries the concept would create a duplicate of it.
 *
 * `assign` decisions pass through untouched. The guard's job is to stop *creates* it
 * believes are duplicates; an assignment the model made is already the outcome the guard
 * is biased toward, and second-guessing it here would be this function inventing a routing
 * opinion it has no evidence for.
 */
export function applyDuplicateGuard(input: {
  readonly proposals: readonly RoutingProposal[];
  readonly existingTopics: readonly ExistingTopicTitle[];
  readonly threshold?: number;
}): DuplicateGuardResult {
  const threshold = input.threshold ?? DUPLICATE_TITLE_THRESHOLD;
  const existing = input.existingTopics.map((topic) => ({
    id: topic.id,
    title: topic.title,
    embedding: topic.titleEmbedding,
  }));

  const routed: RoutedSegment[] = [];
  const coercions: DuplicateCoercion[] = [];
  const unguarded: UnguardedProposal[] = [];
  /** Creates accepted so far in THIS document, keyed by normalised title. */
  const acceptedByTitle = new Map<string, { proposalKey: string; title: string }>();

  for (const proposal of input.proposals) {
    if (proposal.kind === "assign") {
      routed.push(proposal);
      continue;
    }

    const vector =
      proposal.titleEmbedding !== null && proposal.titleEmbedding.length > 0
        ? proposal.titleEmbedding
        : null;

    // ── Guard 1: does this collide with a topic that already exists? ─────────
    //
    // Cosine, cross-upload, unchanged since PLAN §5 Step A.4: routing calls weeks apart
    // cannot see each other's titles, so near-synonyms between them are accidents and the
    // 0.85 threshold is what keeps the index from piling them up.
    if (vector !== null) {
      const existingHit = nearest(vector, existing, threshold);
      if (existingHit.status === "hit") {
        coercions.push({
          segmentKey: proposal.segmentKey,
          reason: "coerced-to-existing",
          proposedTitle: proposal.title,
          matchedTitle: existingHit.candidate.title,
          topicId: existingHit.candidate.id,
          similarity: existingHit.similarity,
        });
        routed.push({
          segmentKey: proposal.segmentKey,
          kind: "assign",
          topicId: existingHit.candidate.id,
        });
        continue;
      }

      // The course HAS topics but not one of them had a readable title vector, so guard 1
      // never actually ran on this proposal. An empty course legitimately reports
      // `incomparable` too and is not worth a warning — that is the first upload, and there
      // is genuinely nothing to duplicate.
      if (existingHit.status === "incomparable" && existing.length > 0) {
        unguarded.push({
          segmentKey: proposal.segmentKey,
          proposedTitle: proposal.title,
          reason: "no-comparable-existing-vectors",
        });
      }
    } else {
      unguarded.push({
        segmentKey: proposal.segmentKey,
        proposedTitle: proposal.title,
        reason: "no-title-embedding",
      });
    }

    // ── Guard 2: the SAME title, earlier in this same document? ──────────────
    //
    // Title identity, deliberately cosine-free (Wave 6). The router saw every segment in
    // one call: a distinct title is a deliberate distinction it is not this guard's place
    // to override — the measured cost of overriding was 7 legitimately distinct statistics
    // topics folded to 2 (Chi-Square → Sampling Distributions at 0.862, and siblings). The
    // fold that remains is the batch-local shape: many segments naming the one topic this
    // batch creates, in whatever capitalisation, grouped onto the first spelling.
    const titleKey = normaliseTitle(proposal.title);
    const prior = acceptedByTitle.get(titleKey);
    if (prior !== undefined) {
      coercions.push({
        segmentKey: proposal.segmentKey,
        reason: "merged-into-proposal",
        proposedTitle: proposal.title,
        matchedTitle: prior.title,
        similarity: 1,
      });
      routed.push({
        segmentKey: proposal.segmentKey,
        kind: "create",
        proposalKey: prior.proposalKey,
        title: prior.title,
        rationale: proposal.rationale,
      });
      continue;
    }

    const proposalKey = `new:${proposal.segmentKey}`;
    acceptedByTitle.set(titleKey, { proposalKey, title: proposal.title });
    routed.push({
      segmentKey: proposal.segmentKey,
      kind: "create",
      proposalKey,
      title: proposal.title,
      rationale: proposal.rationale,
    });
  }

  return { routed, coercions, unguarded };
}
