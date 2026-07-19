import { describe, expect, it } from "vitest";
import {
  applyDuplicateGuard,
  cosineSimilarity,
  DUPLICATE_TITLE_THRESHOLD,
  type ExistingTopicTitle,
  type RoutingProposal,
} from "./duplicate-guard";

/**
 * A unit vector at `angle` radians in the first two dimensions, padded to `dims`.
 *
 * Building vectors from an angle rather than hand-writing floats is what makes these tests
 * readable: `cos(angle)` IS the similarity against the zero-angle vector, so a test that
 * wants "just above 0.85" asks for `Math.acos(0.86)` and the intent survives the arithmetic.
 */
function vectorAt(angle: number, dims = 8): number[] {
  const vector = new Array<number>(dims).fill(0);
  vector[0] = Math.cos(angle);
  vector[1] = Math.sin(angle);
  return vector;
}

/** A vector whose cosine against `vectorAt(0)` is exactly `similarity`. */
function vectorWithSimilarity(similarity: number, dims = 8): number[] {
  return vectorAt(Math.acos(similarity), dims);
}

const BASE = vectorAt(0);

function existing(overrides: Partial<ExistingTopicTitle> = {}): ExistingTopicTitle {
  return {
    id: "topic-nn",
    title: "Neural Networks",
    titleEmbedding: BASE,
    ...overrides,
  };
}

function createProposal(
  segmentKey: string,
  title: string,
  titleEmbedding: readonly number[] | null,
): RoutingProposal {
  return { segmentKey, kind: "create", title, rationale: "no candidate fits", titleEmbedding };
}

describe("cosineSimilarity", () => {
  it("is 1 for a vector against itself, without floating-point overshoot", () => {
    const similarity = cosineSimilarity([0.6, 0.8, 0], [0.6, 0.8, 0]);
    expect(similarity).not.toBeNull();
    expect(similarity).toBeLessThanOrEqual(1);
    expect(similarity).toBeCloseTo(1, 12);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 12);
  });

  it("is scale-invariant", () => {
    expect(cosineSimilarity([1, 2, 3], [10, 20, 30])).toBeCloseTo(1, 12);
  });

  it("reconstructs the similarity a vector was built to have", () => {
    expect(cosineSimilarity(BASE, vectorWithSimilarity(0.85))).toBeCloseTo(0.85, 12);
  });

  /**
   * The distinction the whole guard rests on: an incomparable pair must NOT read as
   * "measured, unrelated". A dimension mismatch means two embedding models got mixed, and
   * reporting that as 0 would let every proposal through as novel.
   */
  it("returns null rather than 0 when the vectors cannot be compared", () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBeNull();
    expect(cosineSimilarity([], [])).toBeNull();
    expect(cosineSimilarity([0, 0], [1, 0])).toBeNull();
  });
});

describe("applyDuplicateGuard — the 0.85 coercion", () => {
  it("coerces a create into an assignment at exactly the threshold", () => {
    const result = applyDuplicateGuard({
      proposals: [
        createProposal(
          "seg-1",
          "Neural Nets — Intro",
          vectorWithSimilarity(DUPLICATE_TITLE_THRESHOLD),
        ),
      ],
      existingTopics: [existing()],
    });

    expect(result.routed).toEqual([{ segmentKey: "seg-1", kind: "assign", topicId: "topic-nn" }]);
    expect(result.coercions).toHaveLength(1);
    expect(result.coercions[0]).toMatchObject({
      segmentKey: "seg-1",
      reason: "coerced-to-existing",
      proposedTitle: "Neural Nets — Intro",
      matchedTitle: "Neural Networks",
      topicId: "topic-nn",
    });
  });

  it("leaves a create alone just below the threshold", () => {
    const result = applyDuplicateGuard({
      proposals: [createProposal("seg-1", "Convolutions", vectorWithSimilarity(0.84))],
      existingTopics: [existing()],
    });

    expect(result.coercions).toEqual([]);
    expect(result.routed[0]).toMatchObject({ kind: "create", title: "Convolutions" });
  });

  it("coerces to the NEAREST topic, not merely the first one over the line", () => {
    const result = applyDuplicateGuard({
      proposals: [createProposal("seg-1", "Nets", vectorWithSimilarity(0.99))],
      existingTopics: [
        existing({ id: "topic-far", title: "Far", titleEmbedding: vectorWithSimilarity(0.86) }),
        existing({ id: "topic-near", title: "Near", titleEmbedding: vectorWithSimilarity(0.995) }),
      ],
    });

    expect(result.routed[0]).toMatchObject({ kind: "assign", topicId: "topic-near" });
    expect(result.coercions[0]?.matchedTitle).toBe("Near");
  });

  it("passes assignments straight through and never second-guesses them", () => {
    const result = applyDuplicateGuard({
      proposals: [{ segmentKey: "seg-1", kind: "assign", topicId: "topic-other" }],
      existingTopics: [existing()],
    });

    expect(result.routed).toEqual([
      { segmentKey: "seg-1", kind: "assign", topicId: "topic-other" },
    ]);
    expect(result.coercions).toEqual([]);
    expect(result.unguarded).toEqual([]);
  });
});

describe("applyDuplicateGuard — intra-document cross-checking", () => {
  /**
   * PLAN §5 Step A.4's second sentence. Neither proposal collides with anything that
   * already exists, so guard 1 clears both — and without guard 2 one document creates two
   * topics for one concept in a single run.
   */
  it("collapses two near-identical proposals in the same document onto one new topic", () => {
    const result = applyDuplicateGuard({
      proposals: [
        createProposal("seg-1", "Market Segmentation", BASE),
        createProposal("seg-9", "Segmenting Markets", vectorWithSimilarity(0.93)),
      ],
      existingTopics: [],
    });

    expect(result.routed).toHaveLength(2);
    const [first, second] = result.routed;
    expect(first).toMatchObject({ kind: "create", title: "Market Segmentation" });
    expect(second).toMatchObject({ kind: "create", title: "Market Segmentation" });

    // Same proposalKey is the whole point: it is what makes them ONE topic downstream.
    const firstKey = first?.kind === "create" ? first.proposalKey : null;
    const secondKey = second?.kind === "create" ? second.proposalKey : null;
    expect(firstKey).not.toBeNull();
    expect(secondKey).toBe(firstKey);

    expect(result.coercions).toHaveLength(1);
    expect(result.coercions[0]).toMatchObject({
      segmentKey: "seg-9",
      reason: "merged-into-proposal",
      matchedTitle: "Market Segmentation",
    });
  });

  it("keeps genuinely distinct proposals in the same document apart", () => {
    const result = applyDuplicateGuard({
      proposals: [
        createProposal("seg-1", "Market Segmentation", BASE),
        createProposal("seg-2", "Distribution Channels", vectorAt(Math.PI / 2)),
      ],
      existingTopics: [],
    });

    const keys = result.routed.map((entry) => (entry.kind === "create" ? entry.proposalKey : null));
    expect(new Set(keys).size).toBe(2);
    expect(result.coercions).toEqual([]);
  });

  /**
   * The running-fold property. Three proposals that are each close to the first must all
   * land on the first — not chain onto each other, which would let drift accumulate
   * (a→b→c where a and c are unrelated).
   */
  it("collapses a run of similar proposals onto the FIRST one", () => {
    const result = applyDuplicateGuard({
      proposals: [
        createProposal("seg-1", "Elasticity", BASE),
        createProposal("seg-2", "Price Elasticity", vectorWithSimilarity(0.95)),
        createProposal("seg-3", "Elasticity of Demand", vectorWithSimilarity(0.9)),
      ],
      existingTopics: [],
    });

    const titles = result.routed.map((entry) => (entry.kind === "create" ? entry.title : null));
    expect(titles).toEqual(["Elasticity", "Elasticity", "Elasticity"]);
    expect(result.coercions).toHaveLength(2);
  });

  it("prefers an existing topic over an earlier proposal when both are close", () => {
    const result = applyDuplicateGuard({
      proposals: [
        createProposal("seg-1", "Elasticity Basics", vectorWithSimilarity(0.5)),
        createProposal("seg-2", "Elasticity", vectorWithSimilarity(0.99)),
      ],
      existingTopics: [
        existing({ id: "topic-elastic", title: "Elasticity", titleEmbedding: BASE }),
      ],
    });

    // seg-1 is far from the existing topic and becomes a new proposal; seg-2 is close to
    // BOTH, and the existing topic must win — merging into a proposal would create a
    // duplicate of a topic that already exists.
    expect(result.routed[1]).toMatchObject({ kind: "assign", topicId: "topic-elastic" });
  });
});

describe("applyDuplicateGuard — when the guard cannot run", () => {
  it("reports an unembeddable title as unguarded rather than silently creating it", () => {
    const result = applyDuplicateGuard({
      proposals: [createProposal("seg-1", "Mystery", null)],
      existingTopics: [existing()],
    });

    expect(result.routed[0]).toMatchObject({ kind: "create", title: "Mystery" });
    expect(result.unguarded).toEqual([
      { segmentKey: "seg-1", proposedTitle: "Mystery", reason: "no-title-embedding" },
    ]);
  });

  it("reports existing topics with no readable vectors as unguarded", () => {
    const result = applyDuplicateGuard({
      proposals: [createProposal("seg-1", "Neural Nets", BASE)],
      existingTopics: [existing({ titleEmbedding: null })],
    });

    expect(result.unguarded).toEqual([
      {
        segmentKey: "seg-1",
        proposedTitle: "Neural Nets",
        reason: "no-comparable-existing-vectors",
      },
    ]);
  });

  /**
   * The empty-course case must stay quiet. It reports `incomparable` for the same reason —
   * nothing was compared — but there is genuinely nothing to duplicate on a first upload,
   * and a warning per proposal would train the reader to ignore the channel.
   */
  it("stays silent on the first upload to an empty course", () => {
    const result = applyDuplicateGuard({
      proposals: [createProposal("seg-1", "Neural Nets", BASE)],
      existingTopics: [],
    });

    expect(result.unguarded).toEqual([]);
    expect(result.coercions).toEqual([]);
  });

  it("does not compare across mismatched vector widths", () => {
    const result = applyDuplicateGuard({
      proposals: [createProposal("seg-1", "Neural Nets", vectorAt(0, 4))],
      existingTopics: [existing({ titleEmbedding: vectorAt(0, 8) })],
    });

    // Identical direction, but different widths — mixing embedding models. It must be
    // reported as unchecked, not coerced on a similarity that was never computed.
    expect(result.coercions).toEqual([]);
    expect(result.unguarded[0]?.reason).toBe("no-comparable-existing-vectors");
  });
});
