import { describe, expect, it } from "vitest";
import { JOB_IDS } from "../models";
import { assertPromptId, definePrompt, jobForPromptId, promptIdViolation } from "./define";
import { PROMPT_REGISTRY } from "./index";

/**
 * §3's id convention, enforced mechanically. A convention only a reviewer can catch is one
 * that will drift — and this one is load-bearing: `where prompt_id = ? and prompt_version < ?`
 * is how a prompt bump finds the rows it needs to regenerate.
 */

describe("prompt id → job resolution", () => {
  it("resolves an id that is exactly a job key", () => {
    expect(jobForPromptId("topic-merge")).toBe("topic-merge");
    expect(jobForPromptId("cards-mcq-numeric")).toBe("cards-mcq-numeric");
  });

  it("resolves a variant-suffixed id to its job", () => {
    // The one legitimate two-prompt job: generation and repair, same model.
    expect(jobForPromptId("lesson-generate-repair")).toBe("lesson-generate");
  });

  it("prefers the longest matching job key", () => {
    // `card-critic` and `card-critic-objective` are both jobs; the longer one must win,
    // or the objective critic would resolve to the wrong model.
    expect(jobForPromptId("card-critic-objective")).toBe("card-critic-objective");
  });

  it("returns undefined for an id that names no job", () => {
    expect(jobForPromptId("echo-example")).toBeUndefined();
    expect(jobForPromptId("summarize")).toBeUndefined();
  });

  it("does not resolve an inherited Object property to a job", () => {
    // `in` walks the prototype chain, so the lookup used to answer "constructor" — which is
    // valid kebab-case and therefore passes `promptIdViolation` too — with a JobId naming no
    // job. `getModel` would then index `MODELS` with `Object.prototype.constructor` and throw
    // on `undefined.rank`. Pinned because this is the prompt→model resolver: it must be able
    // to say "no such job" about every string that is not a key of `JOBS`.
    expect(jobForPromptId("constructor")).toBeUndefined();
    expect(jobForPromptId("constructor-repair")).toBeUndefined();
  });
});

describe("promptIdViolation", () => {
  it("accepts every job key as a valid prompt id", () => {
    for (const job of JOB_IDS) expect(promptIdViolation(job)).toBeUndefined();
  });

  it("accepts a descriptive variant suffix", () => {
    expect(promptIdViolation("lesson-generate-repair")).toBeUndefined();
  });

  it("rejects an id that names no job", () => {
    // This is exactly why the M0 `echo-example` placeholder was retired rather than kept.
    expect(promptIdViolation("echo-example")).toContain("does not start with a job key");
  });

  it("rejects a version encoded in the id", () => {
    expect(promptIdViolation("cards-basic-v2")).toContain("encodes a version");
    expect(promptIdViolation("cards-basic-2")).toContain("encodes a version");
    expect(promptIdViolation("topic-merge-v10")).toContain("encodes a version");
  });

  it("rejects non-kebab-case ids", () => {
    expect(promptIdViolation("TopicMerge")).toContain("kebab-case");
    expect(promptIdViolation("topic_merge")).toContain("kebab-case");
    expect(promptIdViolation("topic--merge")).toContain("kebab-case");
    expect(promptIdViolation("topic-merge-")).toContain("kebab-case");
  });

  it("explains why a version in the id breaks targeted regeneration", () => {
    expect(promptIdViolation("cards-basic-v2")).toContain("prompt_version");
  });
});

describe("assertPromptId", () => {
  it("passes a conformant id and throws on a violation", () => {
    expect(() => assertPromptId("quick-add")).not.toThrow();
    expect(() => assertPromptId("quick-add-v3")).toThrow(/Invalid prompt id/);
  });
});

describe("PROMPT_REGISTRY", () => {
  // Vacuous today — the registry is empty until Agent 4 lands `syllabus-components`.
  // It exists now so the first real template is checked the moment it is added, rather
  // than after the convention has already drifted.

  it("gives every registered prompt a conformant id", () => {
    for (const prompt of PROMPT_REGISTRY) {
      expect(promptIdViolation(prompt.id), `prompt id "${prompt.id}"`).toBeUndefined();
    }
  });

  it("registers each id exactly once — a job owns versions, never several ids", () => {
    const ids = PROMPT_REGISTRY.map((prompt) => prompt.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every registered prompt a positive integer version", () => {
    for (const prompt of PROMPT_REGISTRY) {
      expect(Number.isInteger(prompt.version)).toBe(true);
      expect(prompt.version).toBeGreaterThan(0);
    }
  });

  it("gives every registered prompt a description", () => {
    for (const prompt of PROMPT_REGISTRY) expect(prompt.description.length).toBeGreaterThan(0);
  });
});

describe("definePrompt variable typing", () => {
  it("renders structured variables — objects and arrays, not just strings", () => {
    // The M0 constraint was `Record<string, string | number>`, which forced every caller to
    // pre-stringify. Real prompts pass TopicPage JSON, segment lists and critic verdicts.
    const prompt = definePrompt<{
      topic: { title: string; blocks: readonly string[] };
      segments: readonly { id: number; text: string }[];
      strict: boolean;
    }>({
      id: "topic-merge",
      version: 1,
      description: "Fixture proving structured vars render.",
      render: ({ topic, segments, strict }) =>
        `${topic.title}|${topic.blocks.join(",")}|${segments.map((s) => s.id).join(",")}|${strict}`,
    });

    expect(
      prompt.render({
        topic: { title: "Cash flow", blocks: ["a", "b"] },
        segments: [
          { id: 1, text: "x" },
          { id: 2, text: "y" },
        ],
        strict: true,
      }),
    ).toBe("Cash flow|a,b|1,2|true");
  });

  it("keeps variable names inferred rather than erased to unknown", () => {
    const prompt = definePrompt({
      id: "quick-add",
      version: 2,
      description: "Fixture proving inference survives the widened constraint.",
      render: (vars: { utterance: string; today: string }) => `${vars.today}: ${vars.utterance}`,
    });

    expect(prompt.render({ utterance: "essay due friday", today: "2026-07-19" })).toBe(
      "2026-07-19: essay due friday",
    );
    // @ts-expect-error — a misspelled variable must still be a compile error.
    expect(() => prompt.render({ utterance: "x", todya: "y" })).toBeDefined();
  });
});
