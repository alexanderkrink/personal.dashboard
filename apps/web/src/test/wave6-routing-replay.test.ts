/**
 * The Wave 6 routing replay — LIVE, METERED model calls, gated behind `WAVE6_LIVE_REPLAY=1`.
 *
 * The production run of 2026-07-21 (document `d90be554…`) routed 47 segments with 29
 * distinct headings into ONE topic on an empty index: `topic-routing@1`'s assign-bias is
 * unconditional, and nothing suspends it when there is nothing to assign to. This harness
 * renders the CURRENT routing template over the frozen extraction and measures what the
 * real model returns through the real metered runtime — first under v1 to pin the collapse
 * red (expect 1 create), then under v2 to prove the empty-index mode splits.
 *
 * The identity gate: while the template is still v1, the reconstruction must hash to the
 * recorded `input_hash` — that is what makes the replay a measurement of the production
 * prompt rather than a guess at it. Once the template moves past v1, the hash must differ
 * and the frozen preimage file keeps the v1 evidence.
 *
 * Run it with:
 *
 * ```
 * WAVE6_LIVE_REPLAY=1 pnpm vitest run src/test/wave6-routing-replay.test.ts
 * ```
 *
 * It costs real money (one flash-lite call per suite, ~$0.007) and hits the network, so it
 * is skipped by default. Metered rows are attributed to the disposable fixture tenant —
 * NEVER to a real account.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAIRuntime,
  type RoutableSegment,
  renderRoutableSegments,
  renderTopicIndex,
  routeSegments,
  topicRoutingPrompt,
} from "@study/ai";
import {
  applyDuplicateGuard,
  coalesceSingletonCreates,
  type RoutingProposal,
  resolveRoutingDecisions,
  type Segment,
  type SingletonFold,
  segmentExtraction,
} from "@study/core";
import { createAdminSupabaseClient } from "@study/db";
import { describe, expect, it } from "vitest";
import { createGenerationLogger } from "@/lib/ai/generations";
import { hasWave4Failure, loadWave4Failure } from "./wave4-failure-fixture";
import {
  hasWave6Overmerge,
  loadWave6Overmerge,
  loadWave6Preimage,
  WAVE6_COURSE_TITLE,
  WAVE6_DOCUMENT_LABEL,
  WAVE6_RECORDED_ROUTING_HASH,
  WAVE6_SESSION_LABEL,
} from "./wave6-overmerge-fixture";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "..", "..", ".local-fixtures", "wave6-overmerge");

/** `wave3-syllabus-fixture@example.com` — the disposable fixture tenant. Every metered row
 * must be attributed to somebody, and it must never be a real account. */
const FIXTURE_USER_ID = "106826ab-3c5f-4e07-9539-6b49775f62c7";

/** Reads `.env.local` by hand — vitest does not load it, and `@/env` is Next-only. */
function localEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  let raw = "";
  try {
    raw = readFileSync(join(HERE, "..", "..", ".env.local"), "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const enabled = process.env.WAVE6_LIVE_REPLAY === "1" && hasWave6Overmerge();

interface ReplayMeasurement {
  readonly segments: readonly Segment[];
  readonly decisions: readonly {
    segmentKey: string;
    assignToTopicId: string | null;
    createNewTitle: string | null;
  }[];
  readonly stamp: {
    readonly promptId: string;
    readonly promptVersion: number;
    readonly provider: string;
    readonly model: string;
    readonly inputHash: string;
  };
  /** Merge targets exactly as `planMerges` would group them on an empty course. */
  readonly targets: ReadonlyMap<string, readonly string[]>;
  readonly targetTitles: readonly string[];
  readonly segmentsMerged: number;
  /** One-slide topics the singleton coalesce folded into their deck-adjacent section. */
  readonly folds: readonly SingletonFold[];
}

/**
 * One live routing call over a frozen extraction, then the REAL downstream pipeline:
 * `resolveRoutingDecisions` → `applyDuplicateGuard` → `coalesceSingletonCreates` →
 * `planMerges`-shaped grouping.
 *
 * Title embeddings are deliberately null. On an EMPTY course the cross-upload guard has
 * nothing to compare against, and since Wave 6 the same-batch guard folds on normalised
 * title identity, not cosine — so no vector influences any outcome this harness measures,
 * and calling the embedding API here would be spend without a reading.
 */
async function replayRouting(input: {
  readonly extraction: {
    readonly pages: readonly { page: number; title: string; markdown: string }[];
    readonly headings: readonly { page: number; text: string; level: number }[];
    readonly skipped: readonly { reason: string; fromPage: number; toPage: number }[];
  };
  readonly sourceUnits: number | undefined;
  readonly courseTitle: string;
  readonly documentLabel: string;
  readonly sessionLabel: string | null;
}): Promise<ReplayMeasurement> {
  const { segments } = segmentExtraction({
    pages: input.extraction.pages,
    headings: input.extraction.headings,
    skipped: input.extraction.skipped,
    sourceUnits: input.sourceUnits,
  });

  const routable: RoutableSegment[] = segments.map((segment) => ({
    key: segment.key,
    title: segment.title,
    markdown: segment.markdown,
    candidates: [],
  }));

  const env = localEnv();
  const admin = createAdminSupabaseClient({
    url: env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    secretKey: env.SUPABASE_SECRET_KEY ?? "",
  });
  const logRow = createGenerationLogger(admin, FIXTURE_USER_ID);
  const runtime = createAIRuntime({
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
    googleApiKey: env.GOOGLE_GENERATIVE_AI_API_KEY ?? "",
    maxRank: "deep",
    guard: {
      killSwitch: false,
      monthlyBudgetUsd: Number(env.AI_MONTHLY_BUDGET_USD ?? "50"),
      monthToDateSpend: async () => ({ costUsd: 0, unpricedCalls: 0 }),
    },
    log: async (record) => {
      // eslint-disable-next-line no-console
      console.log(
        `[meter] ${record.promptId}@${record.promptVersion} ${record.model} ${record.outcome} in=${record.usage?.input ?? 0} out=${record.usage?.output ?? 0} hash=${record.inputHash}`,
      );
      await logRow(record);
    },
  });

  const result = await routeSegments({
    runtime,
    courseTitle: input.courseTitle,
    topicIndex: [],
    segments: routable,
    documentLabel: input.documentLabel,
    sessionLabel: input.sessionLabel,
  });

  if (result.status === "dead-letter") {
    throw new Error(`replay dead-lettered: ${result.reason} ${result.message}`);
  }

  const resolution = resolveRoutingDecisions({
    decisions: result.value.decisions,
    segments,
    knownTopicIds: [],
  });

  const proposals: RoutingProposal[] = resolution.proposals.map((proposal) =>
    proposal.kind === "assign" ? proposal : { ...proposal, titleEmbedding: null },
  );
  const guarded = applyDuplicateGuard({ proposals, existingTopics: [] });

  // The canonical stage order since Wave 6 phase 2: resolve → duplicate guard → singleton
  // coalesce → planMerges. The harness measures the pipeline as shipped, so a live run's
  // receipt now records the COALESCED target count — the pre-coalesce shape stays readable
  // in the frozen v5 receipts and in `wave6-singleton-coalesce.test.ts`'s pinned red.
  const coalesced = coalesceSingletonCreates({
    routed: guarded.routed,
    segmentOrder: segments.map((segment) => segment.key),
  });

  // Group into merge targets exactly as `planMerges` does for a course with no topics.
  const byKey = new Map(segments.map((segment) => [segment.key, segment]));
  const targets = new Map<string, string[]>();
  const titles = new Map<string, string>();
  for (const entry of coalesced.routed) {
    if (entry.kind !== "create") continue;
    if (!byKey.has(entry.segmentKey)) continue;
    titles.set(entry.proposalKey, entry.title);
    const grouped = targets.get(entry.proposalKey);
    if (grouped === undefined) targets.set(entry.proposalKey, [entry.segmentKey]);
    else grouped.push(entry.segmentKey);
  }

  return {
    segments,
    decisions: result.value.decisions.map((decision) => ({
      segmentKey: decision.segmentKey,
      assignToTopicId: decision.assignToTopicId,
      createNewTitle: decision.createNewTitle,
    })),
    stamp: result.stamp,
    targets,
    targetTitles: [...targets.keys()].map((key) => titles.get(key) ?? key),
    segmentsMerged: new Set([...targets.values()].flat()).size,
    folds: coalesced.folds,
  };
}

function writeReceipt(name: string, measurement: ReplayMeasurement): void {
  writeFileSync(
    join(FIXTURE_DIR, name),
    JSON.stringify(
      {
        promptVersion: topicRoutingPrompt.version,
        stamp: measurement.stamp,
        segmentCount: measurement.segments.length,
        segmentsMerged: measurement.segmentsMerged,
        targetCount: measurement.targets.size,
        targetTitles: measurement.targetTitles,
        segmentsPerTarget: [...measurement.targets.values()].map((keys) => keys.length),
        // Since Wave 6 phase 2 the receipt measures the coalesced pipeline, and the folds
        // record what the coalesce did — an empty list means the router's own split was
        // already all multi-segment.
        singletonFolds: measurement.folds.map((fold) => ({
          foldedTitle: fold.foldedTitle,
          intoTitle: fold.intoTitle,
        })),
        decisions: measurement.decisions,
      },
      null,
      2,
    ),
  );
}

describe.skipIf(!enabled)(
  "wave6 routing replay — today's frozen extraction (live, metered)",
  () => {
    it("splits the deck into 4–12 topics instead of funnelling it into one", {
      timeout: 300_000,
    }, async () => {
      const fixture = loadWave6Overmerge();
      const sourceUnits = fixture.extractionEnvelope.sourceUnits;

      // ── The identity gate ──────────────────────────────────────────────────
      const rendered = topicRoutingPrompt.render({
        courseTitle: WAVE6_COURSE_TITLE,
        topicIndex: renderTopicIndex([]),
        documentLabel: WAVE6_DOCUMENT_LABEL,
        sessionLabel: WAVE6_SESSION_LABEL ?? "",
        segments: renderRoutableSegments(
          segmentExtraction({
            pages: fixture.extraction.pages,
            headings: fixture.extraction.headings,
            skipped: fixture.extraction.skipped,
            sourceUnits: typeof sourceUnits === "number" ? sourceUnits : undefined,
          }).segments.map((segment) => ({
            key: segment.key,
            title: segment.title,
            markdown: segment.markdown,
            candidates: [],
          })),
        ),
      });
      const preimage = `topic-routing@${topicRoutingPrompt.version}\n${rendered}`;
      const hash = createHash("sha256").update(preimage, "utf8").digest("hex");

      if (topicRoutingPrompt.version === 1) {
        // v1: this run IS the production prompt, byte for byte — the red-pin run.
        expect(preimage).toBe(loadWave6Preimage());
        expect(hash).toBe(WAVE6_RECORDED_ROUTING_HASH);
      } else {
        // v2+: the template moved on; the frozen preimage keeps the v1 evidence.
        expect(hash).not.toBe(WAVE6_RECORDED_ROUTING_HASH);
      }

      const measurement = await replayRouting({
        extraction: fixture.extraction,
        sourceUnits: typeof sourceUnits === "number" ? sourceUnits : undefined,
        courseTitle: WAVE6_COURSE_TITLE,
        documentLabel: WAVE6_DOCUMENT_LABEL,
        sessionLabel: WAVE6_SESSION_LABEL,
      });

      writeReceipt(`routing-replay-v${topicRoutingPrompt.version}.json`, measurement);
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            promptVersion: topicRoutingPrompt.version,
            segmentCount: measurement.segments.length,
            segmentsMerged: measurement.segmentsMerged,
            targetCount: measurement.targets.size,
            targetTitles: measurement.targetTitles,
            segmentsPerTarget: [...measurement.targets.values()].map((keys) => keys.length),
          },
          null,
          2,
        ),
      );

      // Every segment still reaches a merge target — the Wave 5 invariant must survive the
      // split.
      expect(measurement.segmentsMerged).toBe(measurement.segments.length);

      // The acceptance band: several concept-shaped topics, not one deck-shaped one.
      const distinctTitles = new Set(
        measurement.targetTitles.map((title) => title.trim().toLowerCase()),
      );
      expect(distinctTitles.size).toBeGreaterThanOrEqual(4);
      expect(measurement.targets.size).toBeLessThanOrEqual(12);

      // The deck's own title must not be the only thing the router can think of. It may
      // legitimately name ONE topic (the deck is about sampling distributions); it must not
      // be the whole index.
      expect(measurement.targetTitles.length).toBeGreaterThan(1);

      // ── The metering row: attributed, priced, versioned ────────────────────
      const env = localEnv();
      const admin = createAdminSupabaseClient({
        url: env.NEXT_PUBLIC_SUPABASE_URL ?? "",
        secretKey: env.SUPABASE_SECRET_KEY ?? "",
      });
      const rows = await admin
        .from("ai_generations")
        .select("user_id, prompt_id, prompt_version, provider, model, cost_usd, outcome")
        .eq("input_hash", measurement.stamp.inputHash)
        .eq("user_id", FIXTURE_USER_ID);
      if (rows.error) throw rows.error;
      const row = rows.data?.find((candidate) => candidate.outcome === "success");
      expect(row).toBeDefined();
      expect(row?.prompt_id).toBe("topic-routing");
      expect(row?.prompt_version).toBe(topicRoutingPrompt.version);
      expect(row?.provider).toBe("google");
      expect(row?.cost_usd ?? 0).toBeGreaterThan(0);
    });
  },
);

/**
 * No regression on the other known input: the Wave 4 deck, which under v1 already split
 * into 7 creates (the wave5 measurement) that the old guard then folded to 2. Under v2 and
 * the title-identity guard, at least 4 targets must survive end to end.
 *
 * Runs only once the template has moved past v1 — the v1 behaviour on this input is already
 * measured and frozen in `wave4-failure/wave5-routing-replay.json`, and re-buying it would
 * be spend without information.
 */
describe.skipIf(!enabled || !hasWave4Failure() || topicRoutingPrompt.version < 2)(
  "wave6 routing replay — the wave 4 deck under the new prompt (live, metered)",
  () => {
    it("still yields 4–12 topics on the input that used to fold to 2", {
      timeout: 300_000,
    }, async () => {
      const fixture = loadWave4Failure();
      const sourceUnits = fixture.extractionEnvelope.sourceUnits;

      const measurement = await replayRouting({
        extraction: fixture.extraction,
        sourceUnits: typeof sourceUnits === "number" ? sourceUnits : undefined,
        courseTitle: WAVE6_COURSE_TITLE,
        documentLabel: WAVE6_DOCUMENT_LABEL,
        sessionLabel: "Chapter 6",
      });

      writeReceipt(`wave4-replay-v${topicRoutingPrompt.version}.json`, measurement);
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            promptVersion: topicRoutingPrompt.version,
            segmentCount: measurement.segments.length,
            segmentsMerged: measurement.segmentsMerged,
            targetCount: measurement.targets.size,
            targetTitles: measurement.targetTitles,
          },
          null,
          2,
        ),
      );

      expect(measurement.segmentsMerged).toBe(measurement.segments.length);
      expect(measurement.targets.size).toBeGreaterThanOrEqual(4);
      expect(measurement.targets.size).toBeLessThanOrEqual(12);
    });
  },
);
