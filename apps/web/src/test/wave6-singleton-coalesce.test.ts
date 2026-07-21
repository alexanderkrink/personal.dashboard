/**
 * The singleton-coalesce step, measured over the FROZEN routing receipts — no live calls.
 *
 * `topic-routing@5` fixed the empty-index collapse (1 → 14 targets on the wave-6 deck) and
 * left a granularity overage: 8 of the 14 targets are one-slide singletons ("Degrees of
 * Freedom"), while the wave-4 deck's 7 targets are all multi-segment and in-band. Alexander
 * decided (2026-07-21) to close the gap with the deterministic singleton-coalesce step —
 * not band widening, not a model re-pin (gemini-3.1-pro-preview was measured at 15 targets
 * for 17× the cost; receipt `routing-replay-v5-PRO-PREVIEW.json`).
 *
 * Everything here replays the frozen decision lists through the REAL downstream pipeline —
 * `resolveRoutingDecisions` → `applyDuplicateGuard` → `coalesceSingletonCreates` →
 * `planMerges`-shaped grouping — so the numbers are measurements of the shipped code over
 * frozen bytes, deterministic and CI-safe (the corpus is gitignored; suites skip when it is
 * absent). The receipts are never rewritten here.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyDuplicateGuard,
  coalesceSingletonCreates,
  type RoutingProposal,
  resolveRoutingDecisions,
  type Segment,
  type SingletonFold,
  segmentExtraction,
} from "@study/core";
import { describe, expect, it } from "vitest";
import { hasWave4Failure, loadWave4Failure } from "./wave4-failure-fixture";
import { describeWithWave6Overmerge, loadWave6Overmerge } from "./wave6-overmerge-fixture";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".local-fixtures",
  "wave6-overmerge",
);

/** The receipt shape `wave6-routing-replay.test.ts` writes. Only the fields read here. */
interface RoutingReceipt {
  readonly promptVersion: number;
  readonly segmentCount: number;
  readonly targetCount: number;
  readonly decisions: readonly {
    readonly segmentKey: string;
    readonly assignToTopicId: string | null;
    readonly createNewTitle: string | null;
  }[];
}

const hasReceipt = (name: string): boolean => existsSync(join(FIXTURE_DIR, name));

function loadReceipt(name: string): RoutingReceipt {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as RoutingReceipt;
}

interface GroupedTarget {
  readonly title: string;
  readonly segmentKeys: readonly string[];
}

interface PipelineMeasurement {
  readonly segments: readonly Segment[];
  /** Targets grouped exactly as `planMerges` groups creates, pre-coalesce. */
  readonly before: ReadonlyMap<string, GroupedTarget>;
  /** The same grouping, post-coalesce. */
  readonly after: ReadonlyMap<string, GroupedTarget>;
  readonly folds: readonly SingletonFold[];
}

/** proposalKey → target, insertion-ordered like `planMerges`' Map. */
function group(
  routed: readonly { kind: string; segmentKey: string; proposalKey?: string; title?: string }[],
  segments: readonly Segment[],
): ReadonlyMap<string, GroupedTarget> {
  const known = new Set(segments.map((segment) => segment.key));
  const targets = new Map<string, { title: string; segmentKeys: string[] }>();
  for (const entry of routed) {
    if (entry.kind !== "create" || entry.proposalKey === undefined) continue;
    if (!known.has(entry.segmentKey)) continue;
    const bucket = targets.get(entry.proposalKey);
    if (bucket === undefined) {
      targets.set(entry.proposalKey, {
        title: entry.title ?? entry.proposalKey,
        segmentKeys: [entry.segmentKey],
      });
    } else {
      bucket.segmentKeys.push(entry.segmentKey);
    }
  }
  return targets;
}

/**
 * The frozen decisions through the real pipeline, once without and once with the coalesce.
 *
 * Empty course, null title embeddings — the exact conditions the receipts were minted
 * under: on an empty index guard 1 has nothing to compare against and guard 2 is
 * title-identity, so no vector influences any outcome measured here.
 */
function replay(
  receipt: RoutingReceipt,
  extraction: {
    readonly pages: readonly { page: number; title: string; markdown: string }[];
    readonly headings: readonly { page: number; text: string; level: number }[];
    readonly skipped: readonly { reason: string; fromPage: number; toPage: number }[];
  },
  sourceUnits: number | undefined,
): PipelineMeasurement {
  const { segments } = segmentExtraction({
    pages: extraction.pages,
    headings: extraction.headings,
    skipped: extraction.skipped,
    sourceUnits,
  });

  const resolution = resolveRoutingDecisions({
    decisions: receipt.decisions.map((decision) => ({ ...decision, rationale: "" })),
    segments,
    knownTopicIds: [],
  });
  const proposals: RoutingProposal[] = resolution.proposals.map((proposal) =>
    proposal.kind === "assign" ? proposal : { ...proposal, titleEmbedding: null },
  );
  const guarded = applyDuplicateGuard({ proposals, existingTopics: [] });

  const coalesced = coalesceSingletonCreates({
    routed: guarded.routed,
    segmentOrder: segments.map((segment) => segment.key),
  });

  return {
    segments,
    before: group([...guarded.routed], segments),
    after: group([...coalesced.routed], segments),
    folds: coalesced.folds,
  };
}

function replayWave6(receiptName: string): PipelineMeasurement {
  const fixture = loadWave6Overmerge();
  const sourceUnits = fixture.extractionEnvelope.sourceUnits;
  return replay(
    loadReceipt(receiptName),
    fixture.extraction,
    typeof sourceUnits === "number" ? sourceUnits : undefined,
  );
}

function replayWave4(receiptName: string): PipelineMeasurement {
  const fixture = loadWave4Failure();
  const sourceUnits = fixture.extractionEnvelope.sourceUnits;
  return replay(
    loadReceipt(receiptName),
    fixture.extraction,
    typeof sourceUnits === "number" ? sourceUnits : undefined,
  );
}

/** Every page cited by any segment of any target — the locator union the merge will see. */
function pageUnion(
  targets: ReadonlyMap<string, GroupedTarget>,
  segments: readonly Segment[],
): readonly number[] {
  const byKey = new Map(segments.map((segment) => [segment.key, segment]));
  return [
    ...new Set(
      [...targets.values()]
        .flatMap((target) => target.segmentKeys)
        .flatMap((key) => byKey.get(key)?.pages ?? []),
    ),
  ].sort((a, b) => a - b);
}

const mergedCount = (targets: ReadonlyMap<string, GroupedTarget>): number =>
  new Set([...targets.values()].flatMap((target) => target.segmentKeys)).size;

/** `"Folded title" → "receiving title"` pairs, for pinning the fold list legibly. */
const foldPairs = (folds: readonly SingletonFold[]): readonly (readonly [string, string])[] =>
  folds.map((fold) => [fold.foldedTitle, fold.intoTitle] as const);

/* ────────────────────────────────────────────────────────────────────────── */
/* Wave 6 deck — flash-lite receipt (the production model)                    */
/* ────────────────────────────────────────────────────────────────────────── */

describeWithWave6Overmerge("singleton coalesce — wave 6 deck, flash-lite receipt (v5)", () => {
  /**
   * RED, pinned: the pre-coalesce pipeline ships 14 targets on this deck — above the ≤ 12
   * band — and 8 of them are one-slide singletons. This is the documented defect shape the
   * coalesce exists to close; it must keep measuring the UN-coalesced pipeline forever, the
   * way the wave-6 corpus pins the funnel.
   */
  it("RED, pinned: before the coalesce, the receipt's 14 targets include 8 singletons", () => {
    const receipt = loadReceipt("routing-replay-v5.json");
    const measurement = replayWave6("routing-replay-v5.json");

    // The rebuilt pipeline reproduces the frozen receipt exactly.
    expect(measurement.before.size).toBe(receipt.targetCount);
    expect(measurement.before.size).toBe(14);

    const sizes = [...measurement.before.values()].map((target) => target.segmentKeys.length);
    expect(sizes.filter((size) => size === 1)).toHaveLength(8);
    expect(measurement.before.size).toBeGreaterThan(12); // out of band, as shipped
  });

  it("coalesces 14 targets to 6, all multi-segment, in the 4–12 band", () => {
    const measurement = replayWave6("routing-replay-v5.json");

    expect(measurement.after.size).toBe(6);
    expect(measurement.after.size).toBeGreaterThanOrEqual(4);
    expect(measurement.after.size).toBeLessThanOrEqual(12);
    for (const target of measurement.after.values()) {
      expect(target.segmentKeys.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("is lossless: 47/47 segments still merged and the page union is unchanged", () => {
    const measurement = replayWave6("routing-replay-v5.json");

    expect(measurement.segments).toHaveLength(47);
    expect(mergedCount(measurement.before)).toBe(47);
    expect(mergedCount(measurement.after)).toBe(47);
    expect(pageUnion(measurement.after, measurement.segments)).toEqual(
      pageUnion(measurement.before, measurement.segments),
    );
  });

  it("folds exactly the 8 one-slide topics, each into its deck-adjacent section", () => {
    const measurement = replayWave6("routing-replay-v5.json");

    expect(foldPairs(measurement.folds)).toEqual([
      ["Course Overview and Objectives", "Statistical Inference"],
      ["Descriptive vs. Inferential Statistics", "Statistical Inference"],
      ["Sampling Methods", "Populations and Samples"],
      ["Sample Mean", "Sampling Distributions"],
      ["Standard Error of the Mean", "Sampling Distributions"],
      ["Sample Variance", "Sampling Distribution of Sample Proportions"],
      ["Sampling Distribution of Sample Variances", "Chi-Square Distribution"],
      ["Degrees of Freedom", "Chi-Square Distribution"],
    ]);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Wave 6 deck — pro-preview receipt (the measured, refuted re-pin)           */
/* ────────────────────────────────────────────────────────────────────────── */

describeWithWave6Overmerge("singleton coalesce — wave 6 deck, pro-preview receipt (v5)", () => {
  const present = hasReceipt("routing-replay-v5-PRO-PREVIEW.json");

  it.skipIf(!present)("coalesces the re-pin's 15 targets into the band too", () => {
    const receipt = loadReceipt("routing-replay-v5-PRO-PREVIEW.json");
    const measurement = replayWave6("routing-replay-v5-PRO-PREVIEW.json");

    // The 17×-cost model still lands above the band — the receipt that refuted the re-pin.
    expect(measurement.before.size).toBe(receipt.targetCount);
    expect(measurement.before.size).toBe(15);

    expect(measurement.after.size).toBe(7);
    expect(measurement.after.size).toBeGreaterThanOrEqual(4);
    expect(measurement.after.size).toBeLessThanOrEqual(12);

    expect(mergedCount(measurement.before)).toBe(47);
    expect(mergedCount(measurement.after)).toBe(47);
    expect(pageUnion(measurement.after, measurement.segments)).toEqual(
      pageUnion(measurement.before, measurement.segments),
    );
  });

  it.skipIf(!present)("folds the pro receipt's 8 singletons into their sections", () => {
    const measurement = replayWave6("routing-replay-v5-PRO-PREVIEW.json");

    expect(foldPairs(measurement.folds)).toEqual([
      ["Overview of Sampling Distributions", "Descriptive vs. Inferential Statistics"],
      ["Simple Random Sample", "Population vs. Sample"],
      ["Sample Mean", "Sampling Distributions"],
      ["Standard Error of the Mean", "Sampling Distributions"],
      ["Finite Population Correction Factor", "Sampling Distributions"],
      ["Sample Variance", "Sampling Distribution of the Sample Proportion"],
      ["Chi-Square Distribution", "Sampling Distribution of the Sample Variance"],
      ["Degrees of Freedom", "Sampling Distribution of the Sample Variance"],
    ]);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Wave 4 deck — both receipts: the step must be a provable NO-OP             */
/* ────────────────────────────────────────────────────────────────────────── */

describe.skipIf(!hasWave4Failure())("singleton coalesce — wave 4 deck is untouched", () => {
  const cases = ["wave4-replay-v5.json", "wave4-replay-v5-PRO-PREVIEW.json"] as const;

  for (const name of cases) {
    it.skipIf(!hasReceipt(name))(`${name}: 7 targets in, 7 byte-stable targets out`, () => {
      const receipt = loadReceipt(name);
      const measurement = replayWave4(name);

      expect(measurement.before.size).toBe(receipt.targetCount);
      expect(measurement.before.size).toBe(7);

      // No singletons on this deck, so the step must change NOTHING: same target set, same
      // composition, same order, zero folds. Byte-stable, not merely count-stable.
      expect(measurement.folds).toEqual([]);
      expect(JSON.stringify([...measurement.after.entries()])).toBe(
        JSON.stringify([...measurement.before.entries()]),
      );
      expect(mergedCount(measurement.after)).toBe(measurement.segments.length);
    });
  }
});
