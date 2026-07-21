/**
 * The Wave 6 over-merge receipts — assertions against the FROZEN production corpus of
 * 2026-07-21, the run that shipped `topicCount: 1` with perfect grounding.
 *
 * Everything here states facts about frozen bytes, so it stays true whatever the live
 * templates and guards do next. The companion live instrument is
 * `wave6-routing-replay.test.ts`; the fix's red/green unit evidence lives beside the code
 * it tests (`duplicate-guard.test.ts`, `funnel-guard.test.ts`, `route-and-merge.test.ts`).
 */

import { createHash } from "node:crypto";
import { detectSingleTopicFunnel, segmentExtraction } from "@study/core";
import { expect, it } from "vitest";
import {
  describeWithWave6Overmerge,
  loadWave6Overmerge,
  loadWave6Preimage,
  WAVE6_RECORDED_ROUTING_HASH,
  WAVE6_TOPIC_ID,
} from "./wave6-overmerge-fixture";

describeWithWave6Overmerge("wave6 receipts — the frozen over-merge corpus", () => {
  it("the frozen routing preimage hashes to the recorded topic-routing@1 input_hash", () => {
    const hash = createHash("sha256").update(loadWave6Preimage(), "utf8").digest("hex");
    expect(hash).toBe(WAVE6_RECORDED_ROUTING_HASH);
    const routing = loadWave6Overmerge().generations.find((row) => row.job === "topic-routing");
    expect(routing?.prompt_version).toBe(1);
    expect(routing?.input_hash).toBe(WAVE6_RECORDED_ROUTING_HASH);
  });

  it("segments the frozen extraction into the 47 segments the router saw", () => {
    const fixture = loadWave6Overmerge();
    const sourceUnits = fixture.extractionEnvelope.sourceUnits;
    const { segments } = segmentExtraction({
      pages: fixture.extraction.pages,
      headings: fixture.extraction.headings,
      skipped: fixture.extraction.skipped,
      sourceUnits: typeof sourceUnits === "number" ? sourceUnits : undefined,
    });
    expect(segments).toHaveLength(47);
  });

  it("the routing digest records one create and 46 title-assigns into it", () => {
    const events = loadWave6Overmerge().events;

    const digest = events.find((event) => event.detail?.startsWith("Routing decisions (47):"));
    expect(digest).toBeDefined();
    // Every one of the 47 decisions resolved to the same create.
    expect(digest?.detail.match(/→new:Sampling Distributions/g)).toHaveLength(47);

    const batchLocal = events.find((event) =>
      event.detail?.includes("46 sections were routed to 1 topic this file is creating"),
    );
    expect(batchLocal).toBeDefined();
  });

  it("coverage measured the over-merge exactly and reported it as health", () => {
    const { coverage } = loadWave6Overmerge();
    expect(coverage.topicCount).toBe(1);
    expect(coverage.pagesMapped).toBe(47);
    expect(coverage.pagesUnmapped).toBe(0);
    expect(coverage.trustworthy).toBe(true);
    expect(coverage.warnings).toEqual([]);
  });

  /**
   * RED, pinned: the guard that could not fire. The frozen run's shape trips the Wave 6
   * predicate — 0 existing topics, 47 routed segments, 1 merge target — and the revision
   * row it actually wrote carries `needs_review: false` with no note anywhere naming the
   * condition. Nothing in the deployed pipeline could record what every number in the
   * corpus was screaming.
   */
  it("RED, pinned: the frozen run trips the funnel predicate, and nothing recorded it", () => {
    const fixture = loadWave6Overmerge();

    // The run's own log states the empty index: "This course has no topics yet."
    const emptyIndex = fixture.events.some((event) =>
      event.detail?.includes("This course has no topics yet"),
    );
    expect(emptyIndex).toBe(true);

    const note = detectSingleTopicFunnel({
      existingTopicCount: 0,
      routedSegmentCount: 47,
      mergeTargetCount: fixture.coverage.topicCount,
    });
    expect(note).not.toBeNull();
    expect(note).toContain("likely under-split");

    // …and the durable channel the flag would ride is empty on the frozen rows.
    const revision = fixture.revisions.find((row) => row.topic_id === WAVE6_TOPIC_ID);
    expect(revision).toBeDefined();
    expect(revision?.needs_review).toBe(false);
    expect(revision?.review_notes).toEqual([]);
  });

  it("a 5-target outcome must not trigger the predicate", () => {
    expect(
      detectSingleTopicFunnel({
        existingTopicCount: 0,
        routedSegmentCount: 47,
        mergeTargetCount: 5,
      }),
    ).toBeNull();
  });
});
