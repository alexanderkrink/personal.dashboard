import { describe, expect, it } from "vitest";
import type { RoutedSegment } from "./duplicate-guard";
import { detectSingleTopicFunnel } from "./funnel-guard";
import { coalesceSingletonCreates } from "./singleton-coalesce";

/**
 * Unit evidence for the singleton-coalesce step (Wave 6 phase 2).
 *
 * Every behavioural assertion here first ran RED against the identity stub (the
 * pre-coalesce pipeline), and the lossless/receiver-rule assertions ran red against
 * deliberately-broken variants — the drop-the-segment mutation and the `≥ 1` receiver
 * mutation. The captured failures are recorded in the Wave 6 phase 2 report; the repo
 * convention is that a guard must be seen to fire before it is trusted (the
 * guard-that-cannot-fire pattern).
 */

/** `seg-3` → deck position 3. Tests name segments by their deck position throughout. */
const order = (count: number): readonly string[] =>
  Array.from({ length: count }, (_, index) => `seg-${index + 1}`);

const create = (position: number, proposalKey: string, title: string): RoutedSegment => ({
  segmentKey: `seg-${position}`,
  kind: "create",
  proposalKey,
  title,
  rationale: `routed ${title}`,
});

const assign = (position: number, topicId: string): RoutedSegment => ({
  segmentKey: `seg-${position}`,
  kind: "assign",
  topicId,
});

/** proposalKey → segmentKeys, exactly as `planMerges` would group the creates. */
function grouped(routed: readonly RoutedSegment[]): ReadonlyMap<string, readonly string[]> {
  const targets = new Map<string, string[]>();
  for (const entry of routed) {
    if (entry.kind !== "create") continue;
    const bucket = targets.get(entry.proposalKey);
    if (bucket === undefined) targets.set(entry.proposalKey, [entry.segmentKey]);
    else bucket.push(entry.segmentKey);
  }
  return targets;
}

describe("coalesceSingletonCreates — the fold", () => {
  it("folds a singleton into the NEARER multi-segment cluster by deck distance", () => {
    // A: seg-1..2 · singleton at seg-5 · B: seg-6..7. Previous receiver segment is seg-2
    // (distance 3), next is seg-6 (distance 1) — the singleton sits inside B's section.
    const routed = [
      create(1, "new:seg-1", "Alpha"),
      create(2, "new:seg-1", "Alpha"),
      create(5, "new:seg-5", "Stray"),
      create(6, "new:seg-6", "Beta"),
      create(7, "new:seg-6", "Beta"),
    ];

    const result = coalesceSingletonCreates({ routed, segmentOrder: order(7) });

    expect(result.folds).toEqual([
      {
        segmentKey: "seg-5",
        foldedTitle: "Stray",
        intoProposalKey: "new:seg-6",
        intoTitle: "Beta",
      },
    ]);
    expect(grouped(result.routed)).toEqual(
      new Map([
        ["new:seg-1", ["seg-1", "seg-2"]],
        ["new:seg-6", ["seg-5", "seg-6", "seg-7"]],
      ]),
    );
    // The receiving cluster's title wins on the folded entry.
    const folded = result.routed.find((entry) => entry.segmentKey === "seg-5");
    expect(folded).toMatchObject({ kind: "create", title: "Beta" });
  });

  it("prefers the PRECEDING cluster on a distance tie — lecture flow", () => {
    // A: seg-1..2 · singleton at seg-3 · B: seg-4..5. Both neighbours are 1 away.
    const routed = [
      create(1, "new:seg-1", "Alpha"),
      create(2, "new:seg-1", "Alpha"),
      create(3, "new:seg-3", "Stray"),
      create(4, "new:seg-4", "Beta"),
      create(5, "new:seg-4", "Beta"),
    ];

    const result = coalesceSingletonCreates({ routed, segmentOrder: order(5) });

    expect(result.folds).toEqual([
      {
        segmentKey: "seg-3",
        foldedTitle: "Stray",
        intoProposalKey: "new:seg-1",
        intoTitle: "Alpha",
      },
    ]);
  });

  it("consecutive singletons never merge with EACH OTHER — each folds to a real cluster", () => {
    // seg-5 and seg-6 are each other's nearest neighbour at distance 1, and both are
    // singletons. Folding them together would build a two-slide topic out of two one-slide
    // topics the router deliberately distinguished. Each must go to an ORIGINAL ≥2 cluster.
    const routed = [
      create(1, "new:seg-1", "Alpha"),
      create(2, "new:seg-1", "Alpha"),
      create(5, "new:seg-5", "Stray one"),
      create(6, "new:seg-6", "Stray two"),
      create(8, "new:seg-8", "Beta"),
      create(9, "new:seg-8", "Beta"),
    ];

    const result = coalesceSingletonCreates({ routed, segmentOrder: order(9) });

    // seg-5: prev seg-2 (3) vs next seg-8 (3) — tie, preceding → Alpha.
    // seg-6: prev seg-2 (4) vs next seg-8 (2) → Beta.
    expect(result.folds).toEqual([
      {
        segmentKey: "seg-5",
        foldedTitle: "Stray one",
        intoProposalKey: "new:seg-1",
        intoTitle: "Alpha",
      },
      {
        segmentKey: "seg-6",
        foldedTitle: "Stray two",
        intoProposalKey: "new:seg-8",
        intoTitle: "Beta",
      },
    ]);
    // Nothing folded into a singleton's own proposal.
    for (const fold of result.folds) {
      expect(["new:seg-1", "new:seg-8"]).toContain(fold.intoProposalKey);
    }
  });

  it("an ALL-SINGLETON routing folds NOTHING — that shape belongs to the funnel machinery", () => {
    // The structural clause: with no ≥2 receiver anywhere, the step must be incapable of
    // collapsing the document. 13 one-segment creates stay 13 targets; silently rebuilding
    // the 1-topic funnel here would be the 2026-07-21 defect re-armed by its own fix.
    const routed = Array.from({ length: 13 }, (_, index) =>
      create(index + 1, `new:seg-${index + 1}`, `Concept ${index + 1}`),
    );

    const result = coalesceSingletonCreates({ routed, segmentOrder: order(13) });

    expect(result.folds).toEqual([]);
    expect(result.routed).toEqual(routed);
    expect(grouped(result.routed).size).toBe(13);
    expect(result.unfolded).toHaveLength(13);
    for (const entry of result.unfolded) {
      expect(entry.reason).toBe("no-multi-segment-receiver");
    }
  });

  it("computes every fold against ORIGINAL cluster sizes — one pass, no cascade", () => {
    // A cluster of 2 receives a fold and reaches 3; a singleton never becomes a receiver by
    // absorbing nothing; and a singleton whose entry was folded away must not have made any
    // other singleton's choice differ. Concretely: seg-4 folds to A (tie → preceding), and
    // seg-4's own dead proposal must not attract seg-5, whose receivers are still A and B.
    const routed = [
      create(2, "new:seg-2", "Alpha"),
      create(3, "new:seg-2", "Alpha"),
      create(4, "new:seg-4", "Stray one"),
      create(5, "new:seg-5", "Stray two"),
      create(6, "new:seg-6", "Beta"),
      create(7, "new:seg-6", "Beta"),
    ];

    const result = coalesceSingletonCreates({ routed, segmentOrder: order(7) });

    expect(result.folds.map((fold) => [fold.segmentKey, fold.intoProposalKey])).toEqual([
      ["seg-4", "new:seg-2"], // prev seg-3 (1) vs next seg-6 (2) → Alpha
      ["seg-5", "new:seg-6"], // prev seg-3 (2) vs next seg-6 (1) → Beta, NOT seg-4's proposal
    ]);
    expect(grouped(result.routed).size).toBe(2);
  });
});

describe("coalesceSingletonCreates — what it refuses to touch", () => {
  it("is lossless: every segment survives, exactly once, with assigns untouched", () => {
    const routed = [
      assign(1, "topic-a"),
      create(2, "new:seg-2", "Alpha"),
      create(3, "new:seg-2", "Alpha"),
      create(4, "new:seg-4", "Stray"),
      assign(5, "topic-b"),
      create(6, "new:seg-6", "Beta"),
      create(7, "new:seg-6", "Beta"),
    ];

    const result = coalesceSingletonCreates({ routed, segmentOrder: order(7) });

    // Total segments before == after, and the key multiset is identical.
    expect(result.routed).toHaveLength(routed.length);
    expect(result.routed.map((entry) => entry.segmentKey).sort()).toEqual(
      routed.map((entry) => entry.segmentKey).sort(),
    );
    // Assign entries pass through by reference — the step has no opinion on them.
    expect(result.routed.find((entry) => entry.segmentKey === "seg-1")).toBe(routed[0]);
    expect(result.routed.find((entry) => entry.segmentKey === "seg-5")).toBe(routed[4]);
    // Non-folded creates are untouched too.
    expect(result.routed.find((entry) => entry.segmentKey === "seg-2")).toBe(routed[1]);
  });

  it("never folds a create into an ASSIGN cluster, however many segments it has", () => {
    // Three segments assigned to one existing topic are a multi-segment cluster in every
    // sense except the one that matters: folding a proposed NEW topic into an EXISTING one
    // on adjacency alone would be a routing opinion with no evidence — that coercion
    // belongs to the duplicate guard's cosine, which has evidence.
    const routed = [
      assign(1, "topic-a"),
      assign(2, "topic-a"),
      assign(3, "topic-a"),
      create(4, "new:seg-4", "Stray"),
    ];

    const result = coalesceSingletonCreates({ routed, segmentOrder: order(4) });

    expect(result.folds).toEqual([]);
    expect(result.routed).toEqual(routed);
    expect(result.unfolded).toEqual([
      { segmentKey: "seg-4", title: "Stray", reason: "no-multi-segment-receiver" },
    ]);
  });

  it("leaves a singleton alone when its segment is not in the deck order", () => {
    const routed = [
      create(1, "new:seg-1", "Alpha"),
      create(2, "new:seg-1", "Alpha"),
      {
        segmentKey: "seg-ghost",
        kind: "create",
        proposalKey: "new:seg-ghost",
        title: "Ghost",
        rationale: "r",
      } as const,
    ];

    const result = coalesceSingletonCreates({ routed, segmentOrder: order(2) });

    expect(result.folds).toEqual([]);
    expect(result.routed).toEqual(routed);
    expect(result.unfolded).toEqual([
      { segmentKey: "seg-ghost", title: "Ghost", reason: "segment-not-in-deck-order" },
    ]);
  });

  it("a fold-produced single target still trips the funnel backstop downstream", () => {
    // One ≥2 cluster plus eleven singletons legitimately coalesces to ONE target under the
    // stated rule. The step must not dodge the funnel predicate by doing so: the backstop
    // runs downstream on the post-coalesce target count and still fires.
    const routed = [
      create(1, "new:seg-1", "Core"),
      create(2, "new:seg-1", "Core"),
      ...Array.from({ length: 11 }, (_, index) =>
        create(index + 3, `new:seg-${index + 3}`, `Stray ${index + 1}`),
      ),
    ];

    const result = coalesceSingletonCreates({ routed, segmentOrder: order(13) });

    expect(result.folds).toHaveLength(11);
    const targets = grouped(result.routed);
    expect(targets.size).toBe(1);
    expect(
      detectSingleTopicFunnel({
        existingTopicCount: 0,
        routedSegmentCount: 13,
        mergeTargetCount: targets.size,
      }),
    ).toContain("funnelled into a single topic");
  });
});
