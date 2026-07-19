import { NoObjectGeneratedError } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AIPausedError, type SpendReading } from "./guard";
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

/** A guard that never blocks. §6's own behaviour is exercised in `guard.test.ts`. */
const openGuard = {
  killSwitch: false,
  monthlyBudgetUsd: 75,
  monthToDateSpend: () => ({ costUsd: 0, unpricedCalls: 0 }),
};

function runtimeWithLog() {
  const logged: AIGenerationRecord[] = [];
  const runtime = createAIRuntime({
    anthropicApiKey: "test-anthropic",
    googleApiKey: "test-google",
    guard: openGuard,
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

describe("the kill switch and the budget guard stop spend before it happens", () => {
  function guardedRuntime(guard: {
    killSwitch: boolean;
    monthlyBudgetUsd: number;
    monthToDateSpend: () => SpendReading | Promise<SpendReading>;
  }) {
    const logged: AIGenerationRecord[] = [];
    const runtime = createAIRuntime({
      anthropicApiKey: "a",
      googleApiKey: "g",
      guard,
      log: (record) => {
        logged.push(record);
      },
    });
    return { runtime, logged };
  }

  it("makes no provider call and no rollup read at all when AI_KILL_SWITCH is set", async () => {
    generateObject.mockResolvedValue({ object: { title: "ok" }, usage: usage(1, 1) });
    const spendReads = vi.fn(() => ({ costUsd: 0, unpricedCalls: 0 }));
    const { runtime, logged } = guardedRuntime({
      killSwitch: true,
      monthlyBudgetUsd: 75,
      monthToDateSpend: spendReads,
    });

    await expect(
      runtime.generateStructured({ prompt, vars: { topic: "x" }, schema }),
    ).rejects.toThrow(AIPausedError);

    // The DoD clause: flipping the switch verifiably stops ALL spend.
    expect(generateObject).not.toHaveBeenCalled();
    expect(logged).toEqual([]);
    // And it costs nothing to enforce — not even a database round trip.
    expect(spendReads).not.toHaveBeenCalled();
  });

  it("defers a deep-rank background job past 100% but still serves it interactively", async () => {
    generateObject.mockResolvedValue({ object: { title: "ok" }, usage: usage(1, 1) });
    const { runtime } = guardedRuntime({
      killSwitch: false,
      monthlyBudgetUsd: 75,
      monthToDateSpend: () => ({ costUsd: 80, unpricedCalls: 0 }),
    });
    // `exam-review` is pinned to Opus (deep). The prompt id must equal the job, so the
    // job override is how a fixture borrows another job's rank.
    const options = { prompt, vars: { topic: "x" }, schema, job: "exam-review" } as const;

    await expect(runtime.generateStructured(options)).rejects.toThrow(/Deferred/);
    expect(generateObject).not.toHaveBeenCalled();

    await expect(
      runtime.generateStructured({ ...options, kind: "interactive" }),
    ).resolves.toMatchObject({ status: "success" });
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it("kills interactive calls too once spend passes 150%", async () => {
    generateObject.mockResolvedValue({ object: { title: "ok" }, usage: usage(1, 1) });
    const { runtime } = guardedRuntime({
      killSwitch: false,
      monthlyBudgetUsd: 75,
      monthToDateSpend: () => ({ costUsd: 200, unpricedCalls: 0 }),
    });

    await expect(
      runtime.generateStructured({ prompt, vars: { topic: "x" }, schema, kind: "interactive" }),
    ).rejects.toMatchObject({ reason: "budget-halt" });
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("guards against the CLAMPED rank, not the rank the job is pinned to", async () => {
    generateObject.mockResolvedValue({ object: { title: "ok" }, usage: usage(1, 1) });
    const runtime = createAIRuntime({
      anthropicApiKey: "a",
      googleApiKey: "g",
      log: () => {},
      maxRank: "fast",
      guard: {
        killSwitch: false,
        monthlyBudgetUsd: 75,
        monthToDateSpend: () => ({ costUsd: 80, unpricedCalls: 0 }),
      },
    });

    // `exam-review` is pinned to Opus, but AI_MAX_TIER=fast already forced it down to
    // Haiku. Deferring it as though it were still a deep job would pause a call that now
    // costs cents — the clamp and the budget guard have to agree on what actually runs.
    await expect(
      runtime.generateStructured({ prompt, vars: { topic: "x" }, schema, job: "exam-review" }),
    ).resolves.toMatchObject({ status: "success" });
  });

  it("treats an unspecified call as background — forgetting defers, it never overspends", async () => {
    generateObject.mockResolvedValue({ object: { title: "ok" }, usage: usage(1, 1) });
    const { runtime } = guardedRuntime({
      killSwitch: false,
      monthlyBudgetUsd: 75,
      monthToDateSpend: () => ({ costUsd: 100, unpricedCalls: 0 }), // 133% — defer-balanced
    });

    // `topic-merge` is Sonnet (balanced) and no `kind` was passed.
    await expect(
      runtime.generateStructured({ prompt, vars: { topic: "x" }, schema }),
    ).rejects.toMatchObject({ reason: "budget-defer-balanced" });
  });

  it("exposes the same decision without making a call, for chat to render politely", async () => {
    const { runtime } = guardedRuntime({
      killSwitch: true,
      monthlyBudgetUsd: 75,
      monthToDateSpend: () => ({ costUsd: 0, unpricedCalls: 0 }),
    });

    await expect(runtime.guardCheck("chat-rag", "interactive")).resolves.toEqual({
      allowed: false,
      reason: "kill-switch",
    });
    expect(generateObject).not.toHaveBeenCalled();
  });

  /**
   * The DoD clause is "AI_KILL_SWITCH=true verifiably stops ALL spend" — not "stops
   * structured calls". The unmetered escapes are the paths that spend without leaving an
   * `ai_generations` row, so a kill switch that missed them would be false exactly where
   * it is least observable. A Wave 4 chat route built on `unmeteredLanguageModel` must be
   * killed by the same env var as everything else.
   */
  it("refuses to hand out a raw model or provider while the kill switch is set", () => {
    const { runtime } = guardedRuntime({
      killSwitch: true,
      monthlyBudgetUsd: 75,
      monthToDateSpend: () => ({ costUsd: 0, unpricedCalls: 0 }),
    });

    expect(() =>
      runtime.unmeteredLanguageModel("chat-rag", "i-will-meter-this-call-myself"),
    ).toThrow(AIPausedError);
    expect(() => runtime.unmeteredProviders("i-will-meter-this-call-myself")).toThrow(
      AIPausedError,
    );
  });

  it("still hands out the raw model when the switch is off — the escape is gated, not removed", () => {
    const { runtime } = guardedRuntime({
      killSwitch: false,
      monthlyBudgetUsd: 75,
      monthToDateSpend: () => ({ costUsd: 0, unpricedCalls: 0 }),
    });

    expect(
      runtime.unmeteredLanguageModel("chat-rag", "i-will-meter-this-call-myself"),
    ).toBeDefined();
    expect(runtime.unmeteredProviders("i-will-meter-this-call-myself")).toBeDefined();
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
      guard: openGuard,
      // `log` is required — a runtime that can spend money without a metering sink is a
      // compile error, which is the structural half of "every call lands a row".
      log: () => {},
      maxRank: "fast",
    });
    // `topic-merge` is pinned to Sonnet (balanced); the clamp forces it down its own family.
    expect(clamped.resolve("topic-merge")).toMatchObject({
      model: "claude-haiku-4-5",
      rank: "fast",
    });
  });
});

/**
 * The multimodal channel (PLAN §4.1: "signed URL → bytes → a `file` part → one
 * `generateObject` call").
 *
 * This exists so that reading a PDF does not require reaching for
 * `unmeteredLanguageModel`. The property under test is therefore the same one the rest of
 * this file tests — metering and the stamp are unaffected — plus the one thing files
 * genuinely change: `input_hash` must identify the *bytes*, not just the words.
 */
describe("file attachments", () => {
  const pdf = (byte: number) => new Uint8Array([0x25, 0x50, 0x44, 0x46, byte]);

  it("sends the prompt text and the file as one user message, text first", async () => {
    generateObject.mockResolvedValueOnce({ object: { title: "ok" }, usage: usage(10, 5) });
    const { runtime } = runtimeWithLog();

    await runtime.generateStructured({
      prompt,
      vars: { topic: "pricing" },
      schema,
      files: [{ data: pdf(1), mediaType: "application/pdf", filename: "s01.pdf" }],
    });

    const call = generateObject.mock.calls[0]?.[0];
    // The bare `prompt` string is replaced by a message — mixing both would be ambiguous.
    expect(call.prompt).toBeUndefined();
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0].role).toBe("user");
    // Text FIRST: the instructions have to be in context before the model reads 40 pages.
    expect(call.messages[0].content[0]).toMatchObject({ type: "text", text: "Merge: pricing" });
    expect(call.messages[0].content[1]).toMatchObject({
      type: "file",
      mediaType: "application/pdf",
      filename: "s01.pdf",
    });
  });

  it("keeps the plain prompt string when there are no files", async () => {
    generateObject.mockResolvedValueOnce({ object: { title: "ok" }, usage: usage(10, 5) });
    const { runtime } = runtimeWithLog();

    await runtime.generateStructured({ prompt, vars: { topic: "pricing" }, schema, files: [] });

    const call = generateObject.mock.calls[0]?.[0];
    expect(call.prompt).toBe("Merge: pricing");
    expect(call.messages).toBeUndefined();
  });

  /**
   * The one that actually matters. Two different PDFs through the same template render
   * identical prompt text, so without folding the bytes into the hash §5's idempotency
   * short-circuit would serve one document's extraction for another's.
   */
  it("gives two different files two different input hashes", async () => {
    generateObject.mockResolvedValue({ object: { title: "ok" }, usage: usage(10, 5) });
    const { runtime, logged } = runtimeWithLog();

    const vars = { topic: "pricing" };
    await runtime.generateStructured({
      prompt,
      vars,
      schema,
      files: [{ data: pdf(1), mediaType: "application/pdf" }],
    });
    await runtime.generateStructured({
      prompt,
      vars,
      schema,
      files: [{ data: pdf(2), mediaType: "application/pdf" }],
    });
    // …and the same bytes twice must still collide, or the short-circuit never fires.
    await runtime.generateStructured({
      prompt,
      vars,
      schema,
      files: [{ data: pdf(1), mediaType: "application/pdf" }],
    });

    const [first, second, third] = logged.map((record) => record.inputHash);
    expect(first).not.toBe(second);
    expect(first).toBe(third);
  });

  it("hashes a file-bearing call differently from the same prompt with no file", async () => {
    generateObject.mockResolvedValue({ object: { title: "ok" }, usage: usage(10, 5) });
    const { runtime, logged } = runtimeWithLog();

    await runtime.generateStructured({ prompt, vars: { topic: "pricing" }, schema });
    await runtime.generateStructured({
      prompt,
      vars: { topic: "pricing" },
      schema,
      files: [{ data: pdf(1), mediaType: "application/pdf" }],
    });

    expect(logged[0]?.inputHash).not.toBe(logged[1]?.inputHash);
  });

  it("meters a file-bearing call exactly like a text one", async () => {
    generateObject.mockResolvedValueOnce({ object: { title: "ok" }, usage: usage(14874, 9462) });
    const { runtime, logged } = runtimeWithLog();

    await runtime.generateStructured({
      prompt,
      vars: { topic: "pricing" },
      schema,
      files: [{ data: pdf(1), mediaType: "application/pdf" }],
    });

    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      promptId: "topic-merge",
      promptVersion: 3,
      job: "topic-merge",
      provider: "anthropic",
      model: "claude-sonnet-5",
      outcome: "success",
      usage: { input: 14874, output: 9462 },
    });
    expect(logged[0]?.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("carries the files through the ladder's corrective retry", async () => {
    generateObject
      .mockRejectedValueOnce(schemaFailure('{"title":'))
      .mockResolvedValueOnce({ object: { title: "ok" }, usage: usage(10, 5) });
    const { runtime } = runtimeWithLog();

    await runtime.generateStructured({
      prompt,
      vars: { topic: "pricing" },
      schema,
      files: [{ data: pdf(1), mediaType: "application/pdf" }],
    });

    // Rung 2 must still see the document, or the retry is answering a different question.
    const retry = generateObject.mock.calls[1]?.[0];
    expect(retry.messages[0].content[1]).toMatchObject({ type: "file" });
    expect(retry.messages[0].content[0].text).toContain("failed validation");
  });
});
