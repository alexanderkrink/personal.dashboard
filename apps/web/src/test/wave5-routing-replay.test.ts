/**
 * The Wave 5 routing replay — a LIVE, METERED model call, gated behind `WAVE5_LIVE_REPLAY=1`.
 *
 * Wave 5 opened with one unsettled question: the failing run merged 1 of 48 segments, and the
 * 47 that vanished did so either because the router returned `assign` decisions naming
 * topic ids that do not exist (dropped at `planMerges`' `if (topic === undefined) continue`),
 * or because the router never returned decisions for them at all. `ai_generations` stores
 * `input_hash` but no response body, and routing decisions are written to no table, so the
 * frozen corpus is byte-identical under both hypotheses.
 *
 * This test settles it by measurement rather than inference: it reconstructs the routing
 * prompt from the frozen extraction, **asserts the reconstruction hashes to the recorded
 * `input_hash` first** — which is what makes the replay a measurement of the real prompt and
 * not a guess at it — and only then re-issues the call and reports what came back.
 *
 * It is skipped by default because it costs money and hits the network. Run it with:
 *
 * ```
 * WAVE5_LIVE_REPLAY=1 pnpm vitest run src/test/wave5-routing-replay.test.ts
 * ```
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAIRuntime,
  createEmbeddingClient,
  renderRoutableSegments,
  renderTopicIndex,
  routeSegments,
  topicRoutingPrompt,
} from "@study/ai";
import {
  applyDuplicateGuard,
  computeCoverage,
  resolveRoutingDecisions,
  segmentExtraction,
} from "@study/core";
import { createAdminSupabaseClient } from "@study/db";
import { describe, expect, it } from "vitest";
import { createGenerationLogger } from "@/lib/ai/generations";
import { hasWave4Failure, loadWave4Failure } from "./wave4-failure-fixture";

const RECORDED_ROUTING_HASH = "cf0ff73796349e6979cd7e9899fcd6fa225f3cc0d3f8eac0d9b5786e2043210f";
const COURSE_TITLE = "PROBABILITY & STATISTICS FOR DATA MANAGEMENT AND ANALYSIS";
const DOCUMENT_LABEL = "Sampling Distributions.pdf";
const SESSION_LABEL = "Chapter 6";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The owner of the frozen document — every metered row must be attributed to somebody. */
const REPLAY_USER_ID = "0092dd81-4436-452f-9517-235cc8ea4cf2";

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

const enabled = process.env.WAVE5_LIVE_REPLAY === "1" && hasWave4Failure();

describe.skipIf(!enabled)("wave5 routing replay (live, metered)", () => {
  it("replays the routing call and reports the decision shape", { timeout: 300_000 }, async () => {
    const fixture = loadWave4Failure();
    const sourceUnits = fixture.extractionEnvelope.sourceUnits;
    const { segments } = segmentExtraction({
      pages: fixture.extraction.pages,
      headings: fixture.extraction.headings,
      skipped: fixture.extraction.skipped,
      sourceUnits: typeof sourceUnits === "number" ? sourceUnits : undefined,
    });

    const routable = segments.map((segment) => ({
      key: segment.key,
      title: segment.title,
      markdown: segment.markdown,
      candidates: [],
    }));

    // ── The gate: this must be the prompt the failing run actually sent ──────
    const rendered = topicRoutingPrompt.render({
      courseTitle: COURSE_TITLE,
      topicIndex: renderTopicIndex([]),
      documentLabel: DOCUMENT_LABEL,
      sessionLabel: SESSION_LABEL,
      segments: renderRoutableSegments(routable),
    });
    const hash = createHash("sha256")
      .update(`topic-routing@${topicRoutingPrompt.version}\n${rendered}`, "utf8")
      .digest("hex");
    expect(hash, "reconstruction must match the recorded routing input_hash").toBe(
      RECORDED_ROUTING_HASH,
    );

    const env = localEnv();
    // The real metered path: this replay must appear in `ai_generations` like any other
    // call, so it is billed, attributed and auditable rather than invisible spend.
    const admin = createAdminSupabaseClient({
      url: env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      secretKey: env.SUPABASE_SECRET_KEY ?? "",
    });
    const logRow = createGenerationLogger(admin, REPLAY_USER_ID);
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
          `[meter] ${record.promptId} ${record.model} ${record.outcome} in=${record.usage?.input ?? 0} out=${record.usage?.output ?? 0} hash=${record.inputHash}`,
        );
        await logRow(record);
      },
    });

    const result = await routeSegments({
      runtime,
      courseTitle: COURSE_TITLE,
      topicIndex: [],
      segments: routable,
      documentLabel: DOCUMENT_LABEL,
      sessionLabel: SESSION_LABEL,
    });

    if (result.status === "dead-letter") {
      throw new Error(`replay dead-lettered: ${result.reason} ${result.message}`);
    }

    const decisions = result.value.decisions;
    const segmentKeys = new Set(segments.map((s) => s.key));
    const assigns = decisions.filter((d) => d.assignToTopicId !== null && d.assignToTopicId !== "");
    const creates = decisions.filter(
      (d) => d.assignToTopicId === null && d.createNewTitle !== null,
    );
    const missing = segments
      .map((s) => s.key)
      .filter((key) => !decisions.some((d) => d.segmentKey === key));
    const unknownKeys = decisions.filter((d) => !segmentKeys.has(d.segmentKey));

    const report = {
      segmentCount: segments.length,
      decisionCount: decisions.length,
      assignCount: assigns.length,
      createCount: creates.length,
      distinctAssignIds: [...new Set(assigns.map((d) => d.assignToTopicId))],
      segmentsWithNoDecision: missing,
      decisionsForUnknownSegments: unknownKeys.map((d) => d.segmentKey),
      decisions: decisions.map((d) => ({
        segmentKey: d.segmentKey,
        assignToTopicId: d.assignToTopicId,
        createNewTitle: d.createNewTitle,
        confidence: d.confidence,
      })),
    };

    writeFileSync(
      join(HERE, "..", "..", ".local-fixtures", "wave4-failure", "wave5-routing-replay.json"),
      JSON.stringify(report, null, 2),
    );

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        { ...report, decisions: `${report.decisions.length} entries (see fixture file)` },
        null,
        2,
      ),
    );

    expect(decisions.length).toBeGreaterThan(0);
  });
});

/**
 * The fixed pipeline, measured end to end against the frozen corpus.
 *
 * This is NOT the production re-run the Wave 5 done-conditions ask for, and must not be
 * reported as one. The failing document belongs to `krinkk02@gmail.com`, which is
 * untouchable, and the corpus holds the extraction rather than the source PDF — so a
 * genuine re-upload is Alexander's to perform, not an agent's.
 *
 * What it does measure, on real data with real embeddings: how many of the 48 segments reach
 * a merge target under the fixed adjudicator, how many topics that produces, and what the
 * resulting `topic_sources.locators` and coverage numbers are. Those are four rows of the
 * acceptance table, filled in with numbers rather than adjectives. It stops short of the
 * merges themselves, which cost real Sonnet calls against a real account.
 */
describe.skipIf(!enabled)("wave5 — the fixed pipeline over the frozen corpus", () => {
  it("lands every segment, and reports the resulting topic and coverage numbers", async () => {
    const fixture = loadWave4Failure();
    const sourceUnits = fixture.extractionEnvelope.sourceUnits;
    const { segments } = segmentExtraction({
      pages: fixture.extraction.pages,
      headings: fixture.extraction.headings,
      skipped: fixture.extraction.skipped,
      sourceUnits: typeof sourceUnits === "number" ? sourceUnits : undefined,
    });

    // The 48 decisions the live replay recorded, replayed offline so this costs no tokens.
    const recorded = JSON.parse(
      readFileSync(
        join(HERE, "..", "..", ".local-fixtures", "wave4-failure", "wave5-routing-replay.json"),
        "utf8",
      ),
    ) as {
      decisions: {
        segmentKey: string;
        assignToTopicId: string | null;
        createNewTitle: string | null;
      }[];
    };

    const resolution = resolveRoutingDecisions({
      decisions: recorded.decisions.map((d) => ({ ...d, rationale: "recorded" })),
      segments,
      knownTopicIds: [],
    });

    // Real title vectors — the duplicate guard groups identical titles by cosine, so a
    // synthetic vector here would be measuring the harness rather than the pipeline.
    const env = localEnv();
    const embeddings = createEmbeddingClient({
      apiKey: env.VOYAGE_API_KEY ?? "",
      killSwitch: false,
      log: async () => {},
    });

    const createTitles = resolution.proposals.flatMap((p) =>
      p.kind === "create" ? [p.title] : [],
    );
    const vectors = await embeddings.embed({
      texts: createTitles,
      inputType: "document",
      purpose: "embed-topic-title",
    });

    let cursor = 0;
    const proposals = resolution.proposals.map((p) => {
      if (p.kind === "assign") return p;
      const titleEmbedding = vectors.embeddings[cursor] ?? null;
      cursor += 1;
      return { ...p, titleEmbedding };
    });

    const guarded = applyDuplicateGuard({ proposals, existingTopics: [] });

    // Group into merge targets exactly as `planMerges` does, for a course with no topics.
    const byKey = new Map(segments.map((s) => [s.key, s]));
    const targets = new Map<string, string[]>();
    for (const entry of guarded.routed) {
      if (entry.kind !== "create") continue;
      if (!byKey.has(entry.segmentKey)) continue;
      const existing = targets.get(entry.proposalKey);
      if (existing === undefined) targets.set(entry.proposalKey, [entry.segmentKey]);
      else existing.push(entry.segmentKey);
    }

    const segmentsMerged = new Set([...targets.values()].flat()).size;
    const mappedPages = [
      ...new Set(
        [...targets.values()].flatMap((keys) => keys.flatMap((key) => byKey.get(key)?.pages ?? [])),
      ),
    ].sort((a, b) => a - b);

    const coverage = computeCoverage({
      sourceUnits: typeof sourceUnits === "number" ? sourceUnits : 0,
      extractedPages: fixture.extraction.pages.map((p) => p.page),
      skipped: fixture.extraction.skipped,
      mappedPages,
      topicCount: targets.size,
    });

    const report = {
      segmentCount: segments.length,
      segmentsMerged,
      topicCount: targets.size,
      topicTitles: [...targets.keys()],
      segmentsPerTopic: [...targets.values()].map((v) => v.length),
      distinctMappedPages: mappedPages.length,
      coverage: {
        pagesTotal: coverage.pagesTotal,
        pagesMapped: coverage.pagesMapped,
        pagesUnmapped: coverage.pagesUnmapped,
        pagesSkipped: coverage.pagesSkipped,
        trustworthy: coverage.trustworthy,
        warnings: coverage.warnings,
      },
      coercions: guarded.coercions.length,
      unguarded: guarded.unguarded.length,
      coercionDetail: [
        ...new Map(
          guarded.coercions.map((c) => [
            `${c.proposedTitle}→${c.matchedTitle}`,
            {
              proposedTitle: c.proposedTitle,
              matchedTitle: c.matchedTitle,
              similarity: Number(c.similarity.toFixed(3)),
              reason: c.reason,
            },
          ]),
        ).values(),
      ],
    };

    writeFileSync(
      join(HERE, "..", "..", ".local-fixtures", "wave4-failure", "wave5-pipeline-measurement.json"),
      JSON.stringify(report, null, 2),
    );

    // The hard invariant.
    expect(segmentsMerged).toBe(segments.length);
  }, 300_000);
});
