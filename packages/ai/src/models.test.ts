import { describe, expect, it } from "vitest";
import { escalationTarget, getModel, JOB_IDS, JOBS, MODEL_IDS, MODELS, RANK } from "./models";

describe("job → model resolution", () => {
  it("resolves topic-merge to Sonnet and topic-routing to Gemini Flash-Lite", () => {
    expect(getModel("topic-merge")).toEqual({
      job: "topic-merge",
      model: "claude-sonnet-5",
      provider: "anthropic",
      rank: "balanced",
    });
    expect(getModel("topic-routing")).toEqual({
      job: "topic-routing",
      model: "gemini-3.1-flash-lite",
      provider: "google",
      rank: "fast",
    });
  });

  it("pins every job to a model that exists in MODELS", () => {
    for (const job of JOB_IDS) expect(MODELS[JOBS[job]]).toBeDefined();
  });

  it("carries the concrete provider for each resolution", () => {
    expect(getModel("doc-structuring").provider).toBe("google");
    expect(getModel("deep-review-audit").provider).toBe("anthropic");
  });
});

describe("cross-family critic invariant", () => {
  // §1: critics deliberately run on a different family than the generator they check —
  // two models from the same family share blind spots, two families don't. If someone
  // re-points a job in JOBS, this is the check that notices they broke verification.
  const criticPairs: readonly (readonly [
    critic: keyof typeof JOBS,
    generator: keyof typeof JOBS,
  ])[] = [
    ["merge-critic", "topic-merge"],
    ["card-critic", "cards-basic"],
    ["card-critic-objective", "cards-mcq-numeric"],
    ["glossary-critic", "glossary-extract"],
    ["deep-review-audit", "doc-structuring"],
  ];

  it.each(criticPairs)("%s runs on a different provider than %s", (critic, generator) => {
    expect(MODELS[JOBS[critic]].provider).not.toBe(MODELS[JOBS[generator]].provider);
  });

  it("coverage-checklist is the one deliberate same-family pairing", () => {
    // It does not verify the Gemini extractor — it matches syllabus objectives against the
    // Sonnet-built topic set, so its generator is Sonnet and the families still differ.
    expect(MODELS[JOBS["coverage-checklist"]].provider).toBe("google");
    expect(MODELS[JOBS["syllabus-outline"]].provider).toBe("anthropic");
  });
});

describe("AI_MAX_TIER clamp", () => {
  it("leaves a job alone when it is already at or below the clamp", () => {
    expect(getModel("topic-routing", { maxRank: "fast" }).model).toBe("gemini-3.1-flash-lite");
    expect(getModel("topic-merge", { maxRank: "deep" }).model).toBe("claude-sonnet-5");
  });

  it("forces a deep job down to the clamp, staying on the same provider", () => {
    // doc-structuring is Google/deep; clamped to fast it must land on Google's fast model,
    // not hop to Anthropic — a clamp is a cost lever, not a provider migration.
    expect(getModel("doc-structuring", { maxRank: "fast" }).model).toBe("gemini-3.1-flash-lite");
    expect(getModel("exam-review", { maxRank: "fast" }).model).toBe("claude-haiku-4-5");
  });

  it("picks the highest rank still allowed, not the cheapest overall", () => {
    expect(getModel("exam-review", { maxRank: "balanced" }).model).toBe("claude-sonnet-5");
  });

  it("never resolves above the clamp for any job", () => {
    for (const job of JOB_IDS) {
      expect(RANK[getModel(job, { maxRank: "fast" }).rank]).toBeLessThanOrEqual(RANK.fast);
    }
  });
});

describe("escalation targets", () => {
  it("escalates Flash-Lite to Sonnet — the cross-provider step §2 names", () => {
    expect(escalationTarget("gemini-3.1-flash-lite")).toBe("claude-sonnet-5");
  });

  it("escalates Sonnet across the provider boundary to Gemini Pro", () => {
    // Both Gemini Pro and Opus sit at `deep`; the cross-family one wins, because a schema
    // failure Sonnet produced is likelier to clear on a different family.
    expect(escalationTarget("claude-sonnet-5")).toBe("gemini-3.1-pro-preview");
  });

  it("accepts a same-provider step when no other family has a model at the next rank", () => {
    // Haiku (anthropic/fast) → the only `balanced` model is Sonnet, also Anthropic.
    // Cross-provider is a preference, not a reason to give up on escalating at all.
    expect(escalationTarget("claude-haiku-4-5")).toBe("claude-sonnet-5");
  });

  it("returns undefined at the top rank — there is nowhere to go, so dead-letter", () => {
    expect(escalationTarget("claude-opus-4-8")).toBeUndefined();
    expect(escalationTarget("gemini-3.1-pro-preview")).toBeUndefined();
  });

  it("is blocked by the AI_MAX_TIER clamp", () => {
    expect(escalationTarget("gemini-3.1-flash-lite", { maxRank: "fast" })).toBeUndefined();
    expect(escalationTarget("gemini-3.1-flash-lite", { maxRank: "balanced" })).toBe(
      "claude-sonnet-5",
    );
    expect(escalationTarget("claude-sonnet-5", { maxRank: "balanced" })).toBeUndefined();
  });

  it("always escalates strictly upward in rank", () => {
    for (const model of MODEL_IDS) {
      const target = escalationTarget(model);
      if (target === undefined) continue;
      expect(RANK[MODELS[target].rank]).toBeGreaterThan(RANK[MODELS[model].rank]);
    }
  });
});
