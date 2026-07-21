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
   * PLAN §5 Step A.4's second sentence — guard 2 — as Wave 6 rescoped it. A single routing
   * call sees every segment of the document at once, so two proposals sharing one TITLE are
   * one deliberate topic named twice (the batch-local reference shape), and two proposals
   * with DIFFERENT titles are a deliberate distinction that the guard must not override.
   * The cosine fold lives only on the cross-upload side, where calls cannot see each other.
   */
  it("collapses two identically-titled proposals in the same document onto one new topic", () => {
    const result = applyDuplicateGuard({
      proposals: [
        createProposal("seg-1", "Market Segmentation", BASE),
        createProposal("seg-9", "Market Segmentation", vectorWithSimilarity(0.93)),
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

  it("keeps distinct same-batch titles apart even at 0.93 cosine similarity", () => {
    const result = applyDuplicateGuard({
      proposals: [
        createProposal("seg-1", "Market Segmentation", BASE),
        createProposal("seg-9", "Segmenting Markets", vectorWithSimilarity(0.93)),
        createProposal("seg-12", "Distribution Channels", vectorAt(Math.PI / 2)),
      ],
      existingTopics: [],
    });

    const keys = result.routed.map((entry) => (entry.kind === "create" ? entry.proposalKey : null));
    expect(new Set(keys).size).toBe(3);
    expect(result.coercions).toEqual([]);
  });

  /**
   * The running-fold property. Every later spelling of the first title must land on the
   * FIRST proposal — not chain onto each other — so the canonical title is stable however
   * many times the router restates it.
   */
  it("collapses a run of identically-titled proposals onto the FIRST one", () => {
    const result = applyDuplicateGuard({
      proposals: [
        createProposal("seg-1", "Elasticity", BASE),
        createProposal("seg-2", "elasticity", vectorWithSimilarity(0.95)),
        createProposal("seg-3", " ELASTICITY ", vectorWithSimilarity(0.9)),
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

/**
 * Wave 6 — the same-batch fold, measured against the real over-merge corpus.
 *
 * The seven titles below are the seven creates the Wave 4 deck's live routing replay
 * actually returned (frozen in `apps/web/.local-fixtures/wave4-failure/
 * wave5-routing-replay.json`, in decision order), and the cosines are the voyage-3.5-lite
 * similarities the Wave 5 pipeline measurement recorded against "Sampling Distributions"
 * (frozen in `wave5-pipeline-measurement.json`). They are all legitimately distinct
 * statistics concepts — and five of the six non-anchor titles sit ABOVE the 0.85 threshold,
 * so the cosine fold collapsed 7 proposals into 2 topics (40 + 8 segments) and the document
 * failed the 4–12 topic gate even when routing itself split correctly.
 *
 * The Central Limit Theorem cosine was never measured — the frozen run only proves it
 * survived the fold, i.e. that it sat below 0.85. Any sub-threshold value reproduces the
 * recorded outcome; 0.80 is used here.
 *
 * Vectors are constructed to those cosines rather than fetched: each title takes its
 * measured cosine in dimension 0 and the orthogonal remainder in a dimension of its own, so
 * cosine(title, anchor) is exactly the frozen number. Unit tests never call the embedding
 * API.
 */
const WAVE5_MEASURED_CREATES = [
  { segmentKey: "seg-1", title: "Sampling Distributions", cosine: 1 },
  { segmentKey: "seg-2", title: "Statistical Inference", cosine: 0.899 },
  { segmentKey: "seg-5", title: "Populations and Samples", cosine: 0.898 },
  { segmentKey: "seg-25", title: "Central Limit Theorem", cosine: 0.8 },
  { segmentKey: "seg-33", title: "Sampling Distributions of Proportions", cosine: 0.958 },
  { segmentKey: "seg-39", title: "Sampling Distributions of Variances", cosine: 0.936 },
  { segmentKey: "seg-42", title: "Chi-Square Distribution", cosine: 0.862 },
] as const;

/** Cosine `cosine` against the anchor (dim 0), remainder in this entry's own dimension. */
function measuredVector(cosine: number, index: number): number[] {
  const vector = new Array<number>(WAVE5_MEASURED_CREATES.length + 1).fill(0);
  vector[0] = cosine;
  vector[index + 1] = Math.sqrt(1 - cosine ** 2);
  return vector;
}

const wave5Proposals = (): RoutingProposal[] =>
  WAVE5_MEASURED_CREATES.map((entry, index) =>
    createProposal(entry.segmentKey, entry.title, measuredVector(entry.cosine, index)),
  );

describe("applyDuplicateGuard — wave 6: same-batch distinctions are deliberate", () => {
  /**
   * RED, pinned: what guard 2 did until Wave 6, transcribed. The router saw every segment
   * of the document in ONE call and still chose seven different titles — a deliberate
   * distinction — and the cosine fold overrode it, collapsing statistics siblings whose
   * *names* are similar because the *field* names them similarly.
   */
  it("RED, pinned: the retired cosine fold collapsed the seven measured creates to two", () => {
    const accepted: { title: string; vector: readonly number[] }[] = [];
    for (const [index, entry] of WAVE5_MEASURED_CREATES.entries()) {
      const vector = measuredVector(entry.cosine, index);
      const hit = accepted.some((candidate) => {
        const similarity = cosineSimilarity(vector, candidate.vector);
        return similarity !== null && similarity >= DUPLICATE_TITLE_THRESHOLD;
      });
      if (!hit) accepted.push({ title: entry.title, vector });
    }

    expect(accepted.map((candidate) => candidate.title)).toEqual([
      "Sampling Distributions",
      "Central Limit Theorem",
    ]);
  });

  it("lets all seven measured distinct titles survive as seven topics", () => {
    const result = applyDuplicateGuard({ proposals: wave5Proposals(), existingTopics: [] });

    const keys = result.routed.map((entry) => (entry.kind === "create" ? entry.proposalKey : null));
    expect(new Set(keys).size).toBe(7);
    expect(result.coercions).toEqual([]);
    const titles = result.routed.map((entry) => (entry.kind === "create" ? entry.title : null));
    expect(titles).toEqual(WAVE5_MEASURED_CREATES.map((entry) => entry.title));
  });

  it("still folds byte-identical titles, without needing a vector at all", () => {
    const result = applyDuplicateGuard({
      proposals: [
        createProposal("seg-1", "Sampling Distributions", null),
        createProposal("seg-3", "Sampling Distributions", null),
      ],
      existingTopics: [],
    });

    const keys = result.routed.map((entry) => (entry.kind === "create" ? entry.proposalKey : null));
    expect(new Set(keys).size).toBe(1);
    expect(result.coercions).toHaveLength(1);
    expect(result.coercions[0]).toMatchObject({
      segmentKey: "seg-3",
      reason: "merged-into-proposal",
      matchedTitle: "Sampling Distributions",
      similarity: 1,
    });
  });

  it("folds identical titles under normalisation — case and whitespace do not distinguish", () => {
    const result = applyDuplicateGuard({
      proposals: [
        createProposal("seg-25", "Central Limit Theorem", null),
        createProposal("seg-30", "  central   limit theorem ", null),
      ],
      existingTopics: [],
    });

    const routedCreates = result.routed.filter((entry) => entry.kind === "create");
    expect(new Set(routedCreates.map((entry) => entry.proposalKey)).size).toBe(1);
    // The first spelling is canonical, exactly as `resolveRoutingDecisions` treats it.
    expect(routedCreates.map((entry) => entry.title)).toEqual([
      "Central Limit Theorem",
      "Central Limit Theorem",
    ]);
  });

  /**
   * The asymmetry, stated from both sides: the CROSS-UPLOAD guard keeps its cosine, because
   * two routing calls weeks apart cannot see each other's titles — drift between them is an
   * accident. "Chi-Square Distribution" at the measured 0.862 against an EXISTING "Sampling
   * Distributions" topic is still coerced.
   */
  it("keeps the 0.85 cosine coercion against EXISTING topics unchanged", () => {
    const anchor = measuredVector(1, 0);
    const result = applyDuplicateGuard({
      proposals: [createProposal("seg-42", "Chi-Square Distribution", measuredVector(0.862, 6))],
      existingTopics: [{ id: "topic-sd", title: "Sampling Distributions", titleEmbedding: anchor }],
    });

    expect(result.routed).toEqual([{ segmentKey: "seg-42", kind: "assign", topicId: "topic-sd" }]);
    expect(result.coercions[0]).toMatchObject({
      reason: "coerced-to-existing",
      matchedTitle: "Sampling Distributions",
    });
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
