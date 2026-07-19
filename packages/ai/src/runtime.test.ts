import { NoObjectGeneratedError } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { definePrompt, type PromptTemplate } from "./prompts/define";
import { type AIGenerationRecord, createAIRuntime, sha256Hex } from "./runtime";

/**
 * The call wrapper Agent 3's `ai_generations` writer plugs into (M1 item 2c).
 *
 * The property under test throughout is that **metering cannot be skipped**: every attempt
 * that actually ran reaches `log` with a complete five-column stamp, including when the
 * ladder is cut short by a transport error on a later rung. An unmetered paid call is a hole
 * in the budget guard, not a cosmetic problem.
 */

const generateObject = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateObject,
}));

/** A complete `LanguageModelUsage`. The AI SDK requires the detail sub-objects. */
function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    inputTokenDetails: {
      noCacheTokens: inputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    outputTokenDetails: { textTokens: outputTokens, reasoningTokens: 0 },
  };
}

const schema = z.object({ title: z.string() });

const prompt = definePrompt<{ topic: string }>({
  // A real job key, per §3: the id IS the job that runs it.
  id: "topic-merge",
  version: 3,
  description: "Test fixture.",
  render: ({ topic }) => `Merge: ${topic}`,
});

function runtimeWithLog() {
  const logged: AIGenerationRecord[] = [];
  const runtime = createAIRuntime({
    anthropicApiKey: "test-anthropic",
    googleApiKey: "test-google",
    log: (record) => {
      logged.push(record);
    },
  });
  return { runtime, logged };
}

/** A schema failure as the AI SDK surfaces it. */
function schemaFailure(text: string) {
  return new NoObjectGeneratedError({
    message: "response did not match schema",
    text,
    response: { id: "r", timestamp: new Date(0), modelId: "m" },
    usage: usage(1_000, 100),
    finishReason: "stop",
  });
}

/** A refusal: the provider maps Anthropic `stop_reason: "refusal"` to `content-filter`. */
function refusal() {
  return new NoObjectGeneratedError({
    message: "the model declined",
    text: undefined,
    response: { id: "r", timestamp: new Date(0), modelId: "m" },
    usage: usage(500, 0),
    finishReason: "content-filter",
  });
}

beforeEach(() => {
  generateObject.mockReset();
});

describe("the five-column stamp is assembled by the wrapper", () => {
  it("stamps prompt_id, prompt_version, provider, model and input_hash without the caller", async () => {
    generateObject.mockResolvedValue({
      object: { title: "ok" },
      usage: usage(1_000, 200),
    });
    const { runtime, logged } = runtimeWithLog();

    const result = await runtime.generateStructured({
      prompt,
      vars: { topic: "cash flow" },
      schema,
    });

    expect(result.status).toBe("success");
    // `topic-merge` is pinned to Sonnet — resolved from the prompt id alone.
    expect(result.stamp).toMatchObject({
      promptId: "topic-merge",
      promptVersion: 3,
      job: "topic-merge",
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    expect(result.stamp.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ ...result.stamp, outcome: "success", attempt: 1 });
  });

  it("hashes the rendered prompt, so the hash is stable and var key order is irrelevant", async () => {
    generateObject.mockResolvedValue({
      object: { title: "ok" },
      usage: usage(1, 1),
    });
    const { runtime } = runtimeWithLog();

    const first = await runtime.generateStructured({ prompt, vars: { topic: "a" }, schema });
    const second = await runtime.generateStructured({ prompt, vars: { topic: "a" }, schema });
    const different = await runtime.generateStructured({ prompt, vars: { topic: "b" }, schema });

    expect(first.stamp.inputHash).toBe(second.stamp.inputHash);
    expect(first.stamp.inputHash).not.toBe(different.stamp.inputHash);
    // The hash is over rendered text, not over a serialized vars object — so no key-order
    // sensitivity is even possible.
    expect(first.stamp.inputHash).toBe(await sha256Hex("topic-merge@3\nMerge: a"));
  });
});

describe("metering survives a transport error mid-ladder", () => {
  it("logs the rungs that already ran and cost money before the throw propagates", async () => {
    generateObject
      .mockRejectedValueOnce(schemaFailure('{"title": 42}'))
      .mockRejectedValueOnce(schemaFailure('{"title": 42}'))
      .mockRejectedValueOnce(new Error("529 overloaded"));
    const { runtime, logged } = runtimeWithLog();

    // The transport error is not the ladder's business — Inngest owns backoff (§6).
    await expect(
      runtime.generateStructured({ prompt, vars: { topic: "x" }, schema }),
    ).rejects.toThrow("529");

    // ...but the two paid attempts that DID complete must still be metered. Batching the
    // emits until after the ladder returned would have dropped both.
    expect(logged.map((r) => r.step)).toEqual(["initial", "corrective-retry"]);
    expect(logged.every((r) => r.outcome === "schema-failure")).toBe(true);
    expect(logged.every((r) => r.inputHash === logged[0]?.inputHash)).toBe(true);
    expect(logged.every((r) => r.usage?.input === 1_000)).toBe(true);
  });

  it("propagates a transport error on the very first rung with nothing to meter", async () => {
    generateObject.mockRejectedValue(new Error("429 rate limit"));
    const { runtime, logged } = runtimeWithLog();

    await expect(
      runtime.generateStructured({ prompt, vars: { topic: "x" }, schema }),
    ).rejects.toThrow("429");
    expect(logged).toEqual([]);
  });
});

describe("the ladder, through the runtime", () => {
  it("meters every rung and stamps the escalated model, not the pinned one", async () => {
    generateObject
      .mockRejectedValueOnce(schemaFailure("bad"))
      .mockRejectedValueOnce(schemaFailure("bad"))
      .mockResolvedValueOnce({
        object: { title: "cleared" },
        usage: usage(10, 5),
      });
    const { runtime, logged } = runtimeWithLog();

    const result = await runtime.generateStructured({ prompt, vars: { topic: "x" }, schema });

    expect(result.status).toBe("success");
    // Sonnet escalates cross-provider to Gemini Pro; the stamp records what actually ran.
    expect(result.stamp).toMatchObject({ provider: "google", model: "gemini-3.1-pro-preview" });
    expect(logged.map((r) => r.model)).toEqual([
      "claude-sonnet-5",
      "claude-sonnet-5",
      "gemini-3.1-pro-preview",
    ]);
    expect(logged.map((r) => r.provider)).toEqual(["anthropic", "anthropic", "google"]);
  });

  it("dead-letters with the raw text persisted, and never a fourth attempt", async () => {
    generateObject.mockRejectedValue(schemaFailure('{"title": 42}'));
    const { runtime, logged } = runtimeWithLog();

    const result = await runtime.generateStructured({ prompt, vars: { topic: "x" }, schema });

    expect(result).toMatchObject({ status: "dead-letter", reason: "schema" });
    expect(result.status === "dead-letter" && result.rawText).toBe('{"title": 42}');
    expect(generateObject).toHaveBeenCalledTimes(3);
    expect(logged).toHaveLength(3);
  });

  it("exits on a refusal without retrying the identical prompt, and logs it", async () => {
    generateObject.mockRejectedValue(refusal());
    const { runtime, logged } = runtimeWithLog();

    const result = await runtime.generateStructured({ prompt, vars: { topic: "x" }, schema });

    expect(result).toMatchObject({ status: "dead-letter", reason: "refusal" });
    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ outcome: "refusal", promptId: "topic-merge" });
  });

  it("appends the validation error to the prompt on the corrective retry only", async () => {
    generateObject.mockRejectedValueOnce(schemaFailure("bad")).mockResolvedValueOnce({
      object: { title: "ok" },
      usage: usage(1, 1),
    });
    const { runtime } = runtimeWithLog();

    await runtime.generateStructured({ prompt, vars: { topic: "x" }, schema });

    expect(generateObject.mock.calls[0]?.[0].prompt).toBe("Merge: x");
    expect(generateObject.mock.calls[1]?.[0].prompt).toContain("failed validation");
  });
});

describe("job resolution and the clamp", () => {
  it("refuses a prompt id that resolves to no job", async () => {
    // `PromptId` would reject this id at compile time. The double assertion is deliberate:
    // it proves the *runtime* guard exists too, for ids that dodge the compiler — read back
    // from the DB, widened to `string`, or cast at a boundary.
    const orphan = {
      id: "echo-example",
      version: 1,
      description: "x",
      render: () => "hi",
    } as unknown as PromptTemplate<Record<string, never>>;
    const { runtime } = runtimeWithLog();

    await expect(runtime.generateStructured({ prompt: orphan, vars: {}, schema })).rejects.toThrow(
      /does not resolve to a job/,
    );
  });

  it("applies the AI_MAX_TIER clamp to the resolved model", () => {
    const clamped = createAIRuntime({
      anthropicApiKey: "a",
      googleApiKey: "g",
      maxRank: "fast",
    });
    // `topic-merge` is pinned to Sonnet (balanced); the clamp forces it down its own family.
    expect(clamped.resolve("topic-merge")).toMatchObject({
      model: "claude-haiku-4-5",
      rank: "fast",
    });
  });
});
