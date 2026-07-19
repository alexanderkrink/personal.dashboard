import type { AIGenerationRecord } from "@study/ai";
import { describe, expect, it } from "vitest";
import { toGenerationRow } from "./generations";

const USER = "00000000-0000-4000-8000-000000000001";

function record(overrides: Partial<AIGenerationRecord> = {}): AIGenerationRecord {
  return {
    promptId: "topic-merge",
    promptVersion: 3,
    job: "topic-merge",
    provider: "anthropic",
    model: "claude-sonnet-5",
    inputHash: "a".repeat(64),
    step: "initial",
    attempt: 1,
    outcome: "success",
    usage: { input: 1_000, output: 200, cacheRead: 0, cacheWrite: 0 },
    latencyMs: 1_234,
    ...overrides,
  };
}

describe("the five-column stamp reaches the row intact", () => {
  it("maps every stamp column", () => {
    expect(toGenerationRow(USER, record())).toMatchObject({
      user_id: USER,
      prompt_id: "topic-merge",
      prompt_version: 3,
      provider: "anthropic",
      model: "claude-sonnet-5",
      input_hash: "a".repeat(64),
    });
  });
});

describe("cost is priced against the model's OWN provider table", () => {
  it("prices a Sonnet call at the durable $3/$15 sticker, not the intro rate", () => {
    // 1000 × $3/MTok + 200 × $15/MTok = $0.003 + $0.003 = $0.006.
    // The intro rate ($2/$10, live until 2026-08-31) would give $0.004 — deliberately not
    // used: budgeting against a rate that expires is how September surprises you.
    expect(toGenerationRow(USER, record()).cost_usd).toBeCloseTo(0.006, 10);
  });

  it("prices a Gemini Flash-Lite call off the Google table", () => {
    const row = toGenerationRow(
      USER,
      record({
        provider: "google",
        model: "gemini-3.1-flash-lite",
        usage: { input: 1_000, output: 200, cacheRead: 0, cacheWrite: 0 },
      }),
    );
    // 1000 × $0.25/MTok + 200 × $1.50/MTok = $0.00025 + $0.0003 = $0.00055.
    // Same tokens as the Sonnet case above, ~11× cheaper — which is the entire reason
    // there is no single price table anymore.
    expect(row.cost_usd).toBeCloseTo(0.00055, 12);
  });

  it("applies Gemini Pro's >200K long-context surcharge to output as well as input", () => {
    const under = toGenerationRow(
      USER,
      record({
        provider: "google",
        model: "gemini-3.1-pro-preview",
        usage: { input: 200_000, output: 10_000, cacheRead: 0, cacheWrite: 0 },
      }),
    );
    const over = toGenerationRow(
      USER,
      record({
        provider: "google",
        model: "gemini-3.1-pro-preview",
        usage: { input: 200_001, output: 10_000, cacheRead: 0, cacheWrite: 0 },
      }),
    );
    // At the threshold: 200000 × $2/M + 10000 × $12/M = $0.40 + $0.12 = $0.52.
    expect(under.cost_usd).toBeCloseTo(0.52, 8);
    // One token over: the whole call re-rates at $4/$18, output included.
    // 200001 × $4/M + 10000 × $18/M = $0.800004 + $0.18 = $0.980004.
    expect(over.cost_usd).toBeCloseTo(0.980004, 8);
  });

  it("does not bill a Gemini cache write at the input rate — Google has no per-token write", () => {
    const row = toGenerationRow(
      USER,
      record({
        provider: "google",
        model: "gemini-3.1-flash-lite",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 100_000 },
      }),
    );
    expect(row.cost_usd).toBe(0);
  });

  it("splits cached input out so a cache read is not billed at the full input rate", () => {
    const row = toGenerationRow(
      USER,
      record({
        usage: { input: 4_000, output: 700, cacheRead: 12_000, cacheWrite: 0 },
      }),
    );
    // §4's chat/RAG line: 4000 × $3/M + 700 × $15/M + 12000 × $0.30/M
    //   = $0.012 + $0.0105 + $0.0036 = $0.0261 — the ≈$0.026/query the plan budgets.
    expect(row.cost_usd).toBeCloseTo(0.0261, 10);
  });
});

describe("failures are logged with their evidence", () => {
  it("keeps the raw text and error of a dead-lettered attempt", () => {
    const row = toGenerationRow(
      USER,
      record({
        outcome: "schema-failure",
        step: "escalation",
        attempt: 3,
        rawText: '{"title": 42}',
        errorMessage: "response did not match schema",
      }),
    );
    expect(row).toMatchObject({
      outcome: "schema-failure",
      step: "escalation",
      attempt: 3,
      raw_text: '{"title": 42}',
      error_message: "response did not match schema",
    });
  });

  it("records NULL cost — not zero — when the provider reported no usage", () => {
    // NULL means "unknown", $0.00 means "genuinely free". The rollup must be able to tell
    // those apart or an un-metered day looks like a cheap one.
    const row = toGenerationRow(USER, record({ usage: undefined }));
    expect(row.cost_usd).toBeNull();
    expect(row.input_tokens).toBe(0);
    expect(row.output_tokens).toBe(0);
  });

  it("rounds latency to an integer, because the column is one", () => {
    expect(toGenerationRow(USER, record({ latencyMs: 1234.7 })).latency_ms).toBe(1235);
  });
});
