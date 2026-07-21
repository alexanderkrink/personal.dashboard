/**
 * The singleton-coalesce step (Wave 6 phase 2) — **code, not LLM**, and the last voice on
 * granularity before routed segments become merge targets.
 *
 * `topic-routing@5` fixed the empty-index collapse (1 → 14 targets on the real wave-6
 * deck), and the remaining overage against the 4–12 acceptance band is *granularity*: the
 * router, drafting an index at concept granularity, gives a one-slide aside ("Degrees of
 * Freedom", one slide inside the chi-square section) its own topic. Wording escalations
 * made it worse (soft calibration → 14, a hard ceiling → 28), and the measured re-pin was
 * refuted (gemini-3.1-pro-preview: 15 targets at 17× cost). So the close is deterministic
 * — ✅ DECIDED 2026-07-21, coalesce over band-widening over re-pin.
 *
 * ## The rule
 *
 * **A singleton create — a proposed NEW topic carrying exactly one segment — folds into
 * the nearest deck-adjacent multi-segment create cluster.** A stray slide belongs with the
 * section it sits inside, and deck order is the evidence for which section that is: the
 * nearer of the previous/next ≥2-segment cluster by segment distance wins, and a tie goes
 * to the preceding one, because a lecture introduces before it elaborates. Everything
 * follows the fold — the segment, its pages, its locators — and the receiving cluster's
 * title wins. Lossless by construction: entries are rewritten, never dropped.
 *
 * ## What it refuses to do
 *
 * - **Fold into anything smaller than 2 segments.** Consecutive singletons do not merge
 *   with each other — two one-slide topics the router deliberately distinguished do not
 *   become a two-slide topic on adjacency alone — and an all-singleton routing folds
 *   NOTHING. That last clause is structural: with no ≥2 receiver there is no fold, so this
 *   step cannot rebuild the 1-topic funnel out of a pathological routing; that shape falls
 *   through to `detectSingleTopicFunnel` and the `needs_review` machinery, which is where
 *   a document-wide judgement belongs.
 * - **Touch `assign` entries, in either direction.** A segment assigned to an existing
 *   topic is a routing decision with an id behind it, and folding a proposed new topic
 *   INTO an existing one on adjacency alone would be a coercion without evidence — that
 *   coercion belongs to the duplicate guard's cosine, which has some.
 *
 * ## One pass, no cascade — the chosen semantics
 *
 * Both eligibility tests read the ORIGINAL cluster sizes, computed once before any fold:
 * a singleton is a cluster that arrived with exactly 1 segment, and a receiver is a
 * cluster that arrived with ≥ 2. A fold therefore cannot promote a neighbouring singleton
 * into a receiver mid-pass (two strays never chain into a fake section), and cannot
 * demote anything either — receivers only grow. The alternative (recompute after each
 * fold) would make the outcome depend on iteration order, and a step this close to the
 * product invariant must not have an outcome a refactor can change.
 *
 * Sits between {@link applyDuplicateGuard} and `planMerges`; the canonical stage order is
 * resolve → duplicate guard → singleton coalesce → planMerges. Pure: no I/O, no clock, no
 * model, no `process.env`.
 */

import type { RoutedSegment } from "./duplicate-guard";

/** One singleton create folded into a neighbouring multi-segment cluster. */
export interface SingletonFold {
  readonly segmentKey: string;
  /** The one-slide topic's title, as the router proposed it. */
  readonly foldedTitle: string;
  readonly intoProposalKey: string;
  readonly intoTitle: string;
}

/**
 * A singleton the step looked at and deliberately left alone.
 *
 * Reported rather than swallowed — same reasoning as the duplicate guard's `unguarded`:
 * "the step did not run on this proposal" must be readable by the caller, or the step
 * silently degrades to a no-op exactly when its input is strangest. `no-multi-segment-
 * receiver` is the structural funnel clause doing its job; `segment-not-in-deck-order` is
 * an input this pipeline never produces (routed keys come from the segments), kept total
 * rather than thrown so a hostile input degrades to "left alone", never to a crash.
 */
export interface UnfoldedSingleton {
  readonly segmentKey: string;
  readonly title: string;
  readonly reason: "no-multi-segment-receiver" | "segment-not-in-deck-order";
}

export interface SingletonCoalesceResult {
  readonly routed: readonly RoutedSegment[];
  readonly folds: readonly SingletonFold[];
  readonly unfolded: readonly UnfoldedSingleton[];
}

interface Cluster {
  readonly proposalKey: string;
  /** The cluster's canonical title — the first spelling, exactly as the guard grouped it. */
  readonly title: string;
  readonly members: { readonly segmentKey: string; readonly position: number | null }[];
}

/**
 * Applies the fold to one document's guarded routing.
 *
 * `segmentOrder` is the deck order — segment keys exactly as segmentation produced them,
 * which is ascending page position. It is the only notion of adjacency here; no embedding,
 * no model, no similarity.
 */
export function coalesceSingletonCreates(input: {
  readonly routed: readonly RoutedSegment[];
  readonly segmentOrder: readonly string[];
}): SingletonCoalesceResult {
  // ── Deck positions ─────────────────────────────────────────────────────────
  const position = new Map<string, number>();
  input.segmentOrder.forEach((key, index) => {
    if (!position.has(key)) position.set(key, index);
  });

  // ── Original clusters, sized once — the no-cascade anchor ─────────────────
  const clusters = new Map<string, Cluster>();
  for (const entry of input.routed) {
    if (entry.kind !== "create") continue;
    let cluster = clusters.get(entry.proposalKey);
    if (cluster === undefined) {
      cluster = { proposalKey: entry.proposalKey, title: entry.title, members: [] };
      clusters.set(entry.proposalKey, cluster);
    }
    cluster.members.push({
      segmentKey: entry.segmentKey,
      position: position.get(entry.segmentKey) ?? null,
    });
  }

  // Receivers indexed by the deck positions of their ORIGINAL members. A singleton's
  // nearest receiver segment identifies the receiving cluster, which handles interleaved
  // clusters correctly: a stray sitting inside a section's span folds into that section.
  const receiverAt = new Map<number, Cluster>();
  for (const cluster of clusters.values()) {
    if (cluster.members.length < 2) continue;
    for (const member of cluster.members) {
      if (member.position !== null) receiverAt.set(member.position, cluster);
    }
  }
  const receiverPositions = [...receiverAt.keys()].sort((a, b) => a - b);

  // ── Decide every fold against those frozen sizes ───────────────────────────
  const foldTo = new Map<string, Cluster>();
  const folds: SingletonFold[] = [];
  const unfolded: UnfoldedSingleton[] = [];

  for (const cluster of clusters.values()) {
    const only = cluster.members.length === 1 ? cluster.members[0] : undefined;
    if (only === undefined) continue;

    if (only.position === null) {
      unfolded.push({
        segmentKey: only.segmentKey,
        title: cluster.title,
        reason: "segment-not-in-deck-order",
      });
      continue;
    }

    // Nearest receiver segment on each side. Linear: a deck is a few dozen segments.
    let previous: number | null = null;
    let next: number | null = null;
    for (const receiverPosition of receiverPositions) {
      if (receiverPosition < only.position) previous = receiverPosition;
      else if (receiverPosition > only.position) {
        next = receiverPosition;
        break;
      }
    }

    // Tie → the preceding cluster (the `<=`): a stray slide elaborates the section that
    // introduced it more often than it previews the next one.
    const chosen =
      previous === null
        ? next
        : next === null
          ? previous
          : only.position - previous <= next - only.position
            ? previous
            : next;

    const receiver = chosen === null ? undefined : receiverAt.get(chosen);
    if (receiver === undefined) {
      unfolded.push({
        segmentKey: only.segmentKey,
        title: cluster.title,
        reason: "no-multi-segment-receiver",
      });
      continue;
    }

    foldTo.set(cluster.proposalKey, receiver);
    folds.push({
      segmentKey: only.segmentKey,
      foldedTitle: cluster.title,
      intoProposalKey: receiver.proposalKey,
      intoTitle: receiver.title,
    });
  }

  // ── Rewrite, never drop ────────────────────────────────────────────────────
  const routed = input.routed.map((entry): RoutedSegment => {
    if (entry.kind !== "create") return entry;
    const receiver = foldTo.get(entry.proposalKey);
    if (receiver === undefined) return entry;
    return {
      segmentKey: entry.segmentKey,
      kind: "create",
      proposalKey: receiver.proposalKey,
      title: receiver.title,
      rationale: entry.rationale,
    };
  });

  return { routed, folds, unfolded };
}
