import { describe, expect, it, vi } from "vitest";
import {
  type AttemptRequest,
  type AttemptResult,
  correctiveMessage,
  runStructuredLadder,
} from "./ladder";
import type { ModelId } from "./models";

const ok = (value: string): AttemptResult<string> => ({ status: "success", value });
const invalid = (message = "expected string, received number"): AttemptResult<string> => ({
  status: "schema-failure",
  message,
  rawText: '{"title": 42}',
});
const refused = (): AttemptResult<string> => ({
  status: "refusal",
  message: "The model declined to answer.",
  rawText: undefined,
});

/** Replays a scripted sequence of outcomes and records what it was asked. */
function scripted(...outcomes: readonly AttemptResult<string>[]) {
  const seen: AttemptRequest[] = [];
  const attempt = vi.fn(async (request: AttemptRequest): Promise<AttemptResult<string>> => {
    seen.push(request);
    const outcome = outcomes[seen.length - 1];
    if (outcome === undefined) throw new Error(`Ladder made an unscripted attempt ${seen.length}`);
    return outcome;
  });
  return { attempt, seen };
}

const start: ModelId = "gemini-3.1-flash-lite";

describe("rung 1 — the initial call", () => {
  it("returns the value and does not retry when the first attempt succeeds", async () => {
    const { attempt, seen } = scripted(ok("fine"));
    const result = await runStructuredLadder({ startModel: start, attempt });

    expect(result).toMatchObject({ status: "success", value: "fine", model: start });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(seen[0]).toMatchObject({ step: "initial", attempt: 1, model: start });
    expect(seen[0]?.corrective).toBeUndefined();
  });
});

describe("rung 2 — one corrective retry", () => {
  it("retries the SAME model with the validation error appended, then succeeds", async () => {
    const { attempt, seen } = scripted(invalid("title must be a string"), ok("fixed"));
    const result = await runStructuredLadder({ startModel: start, attempt });

    expect(result).toMatchObject({ status: "success", value: "fixed", model: start });
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(seen[1]).toMatchObject({ step: "corrective-retry", attempt: 2, model: start });
    expect(seen[1]?.corrective).toBe(correctiveMessage("title must be a string"));
    expect(seen[1]?.corrective).toContain("title must be a string");
  });
});

describe("rung 3 — one cross-provider rank escalation", () => {
  it("escalates Flash-Lite to Sonnet after the corrective retry also fails", async () => {
    const { attempt, seen } = scripted(invalid(), invalid(), ok("cleared on the other family"));
    const result = await runStructuredLadder({ startModel: start, attempt });

    expect(result).toMatchObject({ status: "success", model: "claude-sonnet-5" });
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(seen[2]).toMatchObject({ step: "escalation", attempt: 3, model: "claude-sonnet-5" });
    expect(seen[2]?.corrective).toBeDefined();
  });

  it("does not escalate on the first failure — the corrective retry comes first", async () => {
    const { attempt, seen } = scripted(invalid(), ok("fixed"));
    await runStructuredLadder({ startModel: start, attempt });
    expect(seen.every((request) => request.model === start)).toBe(true);
  });
});

describe("dead-letter — and never a loop", () => {
  it("stops at exactly three attempts when both families reject the output", async () => {
    const { attempt } = scripted(invalid(), invalid(), invalid());
    const result = await runStructuredLadder({ startModel: start, attempt });

    expect(attempt).toHaveBeenCalledTimes(3);
    expect(result.status).toBe("dead-letter");
    expect(result).toMatchObject({ reason: "schema" });
  });

  it("hands back the raw model text so a dead-letter is debuggable", async () => {
    const { attempt } = scripted(invalid(), invalid(), invalid());
    const result = await runStructuredLadder({ startModel: start, attempt });

    expect(result.status === "dead-letter" && result.rawText).toBe('{"title": 42}');
  });

  it("dead-letters immediately when there is nowhere to escalate", async () => {
    // Opus is already top rank, so rung 3 does not exist for it.
    const { attempt } = scripted(invalid(), invalid());
    const result = await runStructuredLadder({ startModel: "claude-opus-4-8", attempt });

    expect(attempt).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: "dead-letter", reason: "no-escalation-target" });
  });

  it("dead-letters without escalating when AI_MAX_TIER forbids the step", async () => {
    const { attempt } = scripted(invalid(), invalid());
    const result = await runStructuredLadder({ startModel: start, attempt, maxRank: "fast" });

    expect(attempt).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: "dead-letter", reason: "no-escalation-target" });
    expect(result.status === "dead-letter" && result.message).toContain("AI_MAX_TIER");
  });
});

describe("refusals are logged, never retried identically", () => {
  it("exits on rung 1 without a corrective retry", async () => {
    const { attempt } = scripted(refused());
    const result = await runStructuredLadder({ startModel: start, attempt });

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "dead-letter", reason: "refusal" });
  });

  it("exits on rung 2 without escalating", async () => {
    const { attempt } = scripted(invalid(), refused());
    const result = await runStructuredLadder({ startModel: start, attempt });

    expect(attempt).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: "dead-letter", reason: "refusal" });
  });

  it("is still reported as a refusal when it happens on the escalated model", async () => {
    const { attempt } = scripted(invalid(), invalid(), refused());
    const result = await runStructuredLadder({ startModel: start, attempt });

    expect(attempt).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ status: "dead-letter", reason: "refusal" });
  });
});

describe("transport errors are not the ladder's business", () => {
  it("propagates so the Inngest step retry policy owns backoff", async () => {
    const attempt = vi.fn(async () => {
      throw new Error("429 rate limit exceeded");
    });
    await expect(runStructuredLadder({ startModel: start, attempt })).rejects.toThrow("429");
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe("attempt records", () => {
  it("records every rung with its model, step and latency for metering", async () => {
    let clock = 1_000;
    const { attempt } = scripted(invalid(), invalid(), ok("done"));
    const result = await runStructuredLadder({
      startModel: start,
      attempt,
      now: () => (clock += 5),
    });

    expect(result.attempts).toHaveLength(3);
    expect(result.attempts.map((a) => a.step)).toEqual([
      "initial",
      "corrective-retry",
      "escalation",
    ]);
    expect(result.attempts.map((a) => a.model)).toEqual([start, start, "claude-sonnet-5"]);
    expect(result.attempts.map((a) => a.outcome)).toEqual([
      "schema-failure",
      "schema-failure",
      "success",
    ]);
    for (const record of result.attempts) expect(record.latencyMs).toBeGreaterThan(0);
  });

  it("keeps the failing raw text on failed attempts and omits it on success", async () => {
    const { attempt } = scripted(invalid(), ok("done"));
    const result = await runStructuredLadder({ startModel: start, attempt });

    expect(result.attempts[0]?.rawText).toBe('{"title": 42}');
    expect(result.attempts[1]?.rawText).toBeUndefined();
  });
});
