import { describe, expect, it } from "vitest";
import {
  createEmbeddingClient,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  type EmbeddingGenerationRecord,
  EmbeddingsPausedError,
  type FetchLike,
  VoyageEmbeddingError,
} from "./embeddings";
import { embeddingPriceUsd } from "./pricing";

const vector = (seed: number): number[] => new Array<number>(EMBEDDING_DIMENSIONS).fill(seed);

/** A Voyage stub. Records every request so ordering and batching can be asserted. */
function stubVoyage(options?: {
  readonly tokensPerCall?: number;
  readonly status?: number;
  readonly shuffle?: boolean;
  readonly dropIndex?: number;
  readonly throws?: boolean;
}) {
  const requests: { readonly input: string[]; readonly inputType: string }[] = [];

  const fetchImpl: FetchLike = async (_url, init) => {
    if (options?.throws === true) throw new Error("socket hang up");

    const body = JSON.parse(init?.body ?? "{}") as { input: string[]; input_type: string };
    requests.push({ input: body.input, inputType: body.input_type });

    if (options?.status !== undefined && options.status !== 200) {
      return {
        ok: false,
        status: options.status,
        json: async () => ({}),
        text: async () => "rate limited",
      };
    }

    let data = body.input.map((_text, index) => ({ index, embedding: vector(index) }));
    if (options?.shuffle === true) data = [...data].reverse();
    if (options?.dropIndex !== undefined) {
      data = data.filter((row) => row.index !== options.dropIndex);
    }

    return {
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({
        object: "list",
        data,
        model: EMBEDDING_MODEL,
        usage: { total_tokens: options?.tokensPerCall ?? 100 },
      }),
    };
  };

  return { fetchImpl, requests };
}

function collector() {
  const rows: EmbeddingGenerationRecord[] = [];
  return { rows, log: (record: EmbeddingGenerationRecord) => void rows.push(record) };
}

describe("createEmbeddingClient — metering", () => {
  /**
   * The M1 DoD sentence, for the retrieval half of the system: every AI call appears in
   * `ai_generations` with a cost. `ai_generations.provider` was widened to admit `voyage`
   * for exactly this row, so a client that could return vectors without writing one would
   * make the widening pointless.
   */
  it("writes one fully-stamped row per request, with a real cost", async () => {
    const { fetchImpl } = stubVoyage({ tokensPerCall: 250 });
    const { rows, log } = collector();
    const client = createEmbeddingClient({ apiKey: "k", log, killSwitch: false, fetchImpl });

    await client.embed({ texts: ["a", "b"], inputType: "document", purpose: "embed-segment" });

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      promptId: "embed-segment",
      job: "embed-segment",
      provider: "voyage",
      model: EMBEDDING_MODEL,
      outcome: "success",
      inputTokens: 250,
    });
    expect(row?.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.promptVersion).toBeGreaterThanOrEqual(1);
    // The gap Agent 0 flagged: a Voyage row must NOT land with a null cost.
    expect(row?.costUsd).not.toBeNull();
    expect(row?.costUsd).toBeCloseTo(embeddingPriceUsd(EMBEDDING_MODEL, 250), 12);
  });

  it("writes one row per HTTP batch, not one per call", async () => {
    const { fetchImpl, requests } = stubVoyage({ tokensPerCall: 10 });
    const { rows, log } = collector();
    const client = createEmbeddingClient({
      apiKey: "k",
      log,
      killSwitch: false,
      fetchImpl,
      batchSize: 2,
    });

    const result = await client.embed({
      texts: ["a", "b", "c", "d", "e"],
      inputType: "document",
      purpose: "embed-chunk",
    });

    expect(requests).toHaveLength(3);
    expect(rows).toHaveLength(3);
    expect(result.embeddings).toHaveLength(5);
    expect(result.totalTokens).toBe(30);
    expect(result.costUsd).toBeCloseTo(embeddingPriceUsd(EMBEDDING_MODEL, 30), 12);
  });

  it("hashes the input type into the stamp, so query and document vectors differ", async () => {
    const { fetchImpl } = stubVoyage();
    const { rows, log } = collector();
    const client = createEmbeddingClient({ apiKey: "k", log, killSwitch: false, fetchImpl });

    await client.embed({ texts: ["same"], inputType: "document", purpose: "embed-segment" });
    await client.embed({ texts: ["same"], inputType: "query", purpose: "embed-query" });

    expect(rows[0]?.inputHash).not.toBe(rows[1]?.inputHash);
  });

  it("still logs a row when the request fails", async () => {
    const { fetchImpl } = stubVoyage({ status: 429 });
    const { rows, log } = collector();
    const client = createEmbeddingClient({ apiKey: "k", log, killSwitch: false, fetchImpl });

    await expect(
      client.embed({ texts: ["a"], inputType: "document", purpose: "embed-segment" }),
    ).rejects.toBeInstanceOf(VoyageEmbeddingError);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "transport-error", costUsd: null });
    expect(rows[0]?.errorMessage).toContain("429");
  });

  it("logs a row when the transport itself throws", async () => {
    const { fetchImpl } = stubVoyage({ throws: true });
    const { rows, log } = collector();
    const client = createEmbeddingClient({ apiKey: "k", log, killSwitch: false, fetchImpl });

    await expect(
      client.embed({ texts: ["a"], inputType: "document", purpose: "embed-segment" }),
    ).rejects.toBeInstanceOf(VoyageEmbeddingError);

    expect(rows[0]).toMatchObject({ outcome: "transport-error" });
    expect(rows[0]?.errorMessage).toContain("socket hang up");
  });
});

describe("createEmbeddingClient — the kill switch", () => {
  /** §6's promise is "one env var stops all spend". A spend path that ignores it breaks that. */
  it("refuses before any request when the kill switch is set", async () => {
    const { fetchImpl, requests } = stubVoyage();
    const { rows, log } = collector();
    const client = createEmbeddingClient({ apiKey: "k", log, killSwitch: true, fetchImpl });

    await expect(
      client.embed({ texts: ["a"], inputType: "document", purpose: "embed-segment" }),
    ).rejects.toBeInstanceOf(EmbeddingsPausedError);

    expect(requests).toEqual([]);
    expect(rows).toEqual([]);
  });
});

describe("createEmbeddingClient — vector integrity", () => {
  /**
   * Order is a correctness property: the caller pairs vectors back to segments by position,
   * so a provider that returns rows out of order would silently attach every segment's
   * meaning to its neighbour. Voyage sends an explicit `index`; this proves it is used.
   */
  it("restores input order from the response index", async () => {
    const { fetchImpl } = stubVoyage({ shuffle: true });
    const { log } = collector();
    const client = createEmbeddingClient({ apiKey: "k", log, killSwitch: false, fetchImpl });

    const result = await client.embed({
      texts: ["a", "b", "c"],
      inputType: "document",
      purpose: "embed-segment",
    });

    expect(result.embeddings.map((embedding) => embedding[0])).toEqual([0, 1, 2]);
  });

  it("throws rather than returning a short array when a vector is missing", async () => {
    const { fetchImpl } = stubVoyage({ dropIndex: 1 });
    const { log } = collector();
    const client = createEmbeddingClient({ apiKey: "k", log, killSwitch: false, fetchImpl });

    await expect(
      client.embed({ texts: ["a", "b", "c"], inputType: "document", purpose: "embed-segment" }),
    ).rejects.toThrow(/index 1 missing/);
  });

  it("sends the input type and the pinned model and dimension", async () => {
    const { fetchImpl, requests } = stubVoyage();
    const { log } = collector();
    const client = createEmbeddingClient({ apiKey: "k", log, killSwitch: false, fetchImpl });

    await client.embed({ texts: ["a"], inputType: "query", purpose: "embed-query" });

    expect(requests[0]?.inputType).toBe("query");
  });

  it("makes no request at all for an empty input list", async () => {
    const { fetchImpl, requests } = stubVoyage();
    const { rows, log } = collector();
    const client = createEmbeddingClient({ apiKey: "k", log, killSwitch: false, fetchImpl });

    const result = await client.embed({
      texts: [],
      inputType: "document",
      purpose: "embed-segment",
    });

    expect(result).toMatchObject({ embeddings: [], totalTokens: 0, costUsd: 0 });
    expect(requests).toEqual([]);
    expect(rows).toEqual([]);
  });
});

describe("embeddingPriceUsd", () => {
  /**
   * The free-allowance trap, pinned. Voyage's first 200M tokens are free, and returning 0
   * here would be the same mistake as billing Sonnet at its expiring introductory rate: the
   * allowance is an account credit consumed once, not a property of the call. When it runs
   * out, a hard-coded 0 keeps reporting free forever.
   */
  it("prices at the published rate rather than at the free allowance", () => {
    expect(embeddingPriceUsd("voyage-3.5-lite", 1_000_000)).toBeCloseTo(0.02, 12);
    expect(embeddingPriceUsd("voyage-3.5-lite", 0)).toBe(0);
  });
});
