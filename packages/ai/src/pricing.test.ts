import { describe, expect, it } from "vitest";
import { MODEL_IDS, MODELS } from "./models";
import { PRICING, priceUsd, ratesFor } from "./pricing";

describe("price table coverage", () => {
  it("prices every model in the registry, under its own provider", () => {
    for (const model of MODEL_IDS) {
      expect(PRICING[model]).toBeDefined();
      expect(PRICING[model].provider).toBe(MODELS[model].provider);
    }
  });

  it("charges more for output than input everywhere, and less for cache reads", () => {
    for (const model of MODEL_IDS) {
      const { rates } = PRICING[model];
      expect(rates.output).toBeGreaterThan(rates.input);
      expect(rates.cacheRead).toBeLessThan(rates.input);
    }
  });

  it("records no per-token cache-write rate for Google — its caching bills by storage", () => {
    // `null` is not `0`: "not charged this way" must not read as "free".
    expect(PRICING["gemini-3.1-flash-lite"].rates.cacheWrite).toBeNull();
    expect(PRICING["gemini-3.1-pro-preview"].rates.cacheWrite).toBeNull();
    expect(PRICING["claude-sonnet-5"].rates.cacheWrite).toBe(3.75);
  });
});

describe("per-provider rates are not flattened into one table", () => {
  it("prices the same token counts differently per provider", () => {
    const usage = { input: 1_000_000, output: 100_000 };
    expect(priceUsd("gemini-3.1-flash-lite", usage)).toBeCloseTo(0.25 + 0.15, 6);
    expect(priceUsd("claude-sonnet-5", usage)).toBeCloseTo(3.0 + 1.5, 6);
  });

  it("prices cache reads and writes at their own rates", () => {
    const cost = priceUsd("claude-sonnet-5", {
      input: 1_000_000,
      output: 0,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
    });
    expect(cost).toBeCloseTo(3.0 + 0.3 + 3.75, 6);
  });

  it("does not bill Google cache writes at the input rate by accident", () => {
    const withWrite = priceUsd("gemini-3.1-flash-lite", {
      input: 1_000,
      output: 0,
      cacheWrite: 1_000_000,
    });
    const withoutWrite = priceUsd("gemini-3.1-flash-lite", { input: 1_000, output: 0 });
    expect(withWrite).toBe(withoutWrite);
  });
});

describe("gemini-3.1-pro long-context surcharge", () => {
  const under = { input: 150_000, output: 10_000 };
  const over = { input: 250_000, output: 10_000 };

  it("bills the base rate under 200K prompt tokens", () => {
    expect(ratesFor("gemini-3.1-pro-preview", under)).toMatchObject({ input: 2.0, output: 12.0 });
  });

  it("bills the surcharged rate above 200K prompt tokens", () => {
    expect(ratesFor("gemini-3.1-pro-preview", over)).toMatchObject({ input: 4.0, output: 18.0 });
  });

  it("applies the surcharge to OUTPUT too, not just input", () => {
    // The bracket is selected by prompt size but governs the whole call — flattening this
    // into an input-only surcharge would understate every big deck by $6/MTok of output.
    expect(priceUsd("gemini-3.1-pro-preview", over)).toBeCloseTo(
      (250_000 * 4.0 + 10_000 * 18.0) / 1_000_000,
      6,
    );
  });

  it("counts cached prompt tokens toward the 200K threshold", () => {
    // 150K fresh + 100K cached is a 250K prompt; the model reads all of it.
    const rates = ratesFor("gemini-3.1-pro-preview", {
      input: 150_000,
      output: 1_000,
      cacheRead: 100_000,
    });
    expect(rates.input).toBe(4.0);
  });

  it("leaves flat-priced models alone at any size", () => {
    expect(ratesFor("claude-opus-4-8", over)).toMatchObject({ input: 5.0, output: 25.0 });
  });
});

describe("Sonnet introductory pricing", () => {
  const usage = { input: 1_000_000, output: 1_000_000 };

  it("defaults to the durable $3/$15 sticker, as the plan's math does", () => {
    expect(priceUsd("claude-sonnet-5", usage)).toBeCloseTo(3.0 + 15.0, 6);
  });

  it("records the promo rates and its expiry without applying them", () => {
    expect(PRICING["claude-sonnet-5"].introductory).toMatchObject({
      rates: { input: 2.0, output: 10.0 },
      through: "2026-08-31",
    });
  });

  it("applies the promo only when explicitly asked, and only inside the window", () => {
    const introAsOf = (iso: string) =>
      priceUsd("claude-sonnet-5", usage, { introductoryAsOf: new Date(iso) });

    expect(introAsOf("2026-07-19T00:00:00Z")).toBeCloseTo(2.0 + 10.0, 6);
    // Inclusive of the final day...
    expect(introAsOf("2026-08-31T23:59:59Z")).toBeCloseTo(2.0 + 10.0, 6);
    // ...and back to the sticker the moment it lapses. Budgeting against a rate that
    // expires is how a monthly cap gets blown by a calendar page turning.
    expect(introAsOf("2026-09-01T00:00:00Z")).toBeCloseTo(3.0 + 15.0, 6);
  });

  it("does not invent a promo for models that have none", () => {
    const asOf = { introductoryAsOf: new Date("2026-07-19T00:00:00Z") };
    expect(priceUsd("claude-opus-4-8", usage, asOf)).toBeCloseTo(5.0 + 25.0, 6);
  });
});

describe("batch discount", () => {
  it("halves Anthropic batch-eligible models when asked", () => {
    const usage = { input: 1_000_000, output: 0 };
    expect(priceUsd("claude-opus-4-8", usage, { batch: true })).toBeCloseTo(2.5, 6);
  });

  it("is a no-op for models §1 records no batch rate for", () => {
    const usage = { input: 1_000_000, output: 0 };
    expect(priceUsd("gemini-3.1-flash-lite", usage, { batch: true })).toBeCloseTo(0.25, 6);
  });
});

describe("a zero-token call costs nothing", () => {
  it("prices an empty usage record at 0", () => {
    for (const model of MODEL_IDS) {
      expect(priceUsd(model, { input: 0, output: 0 })).toBe(0);
    }
  });
});
