import { describe, expect, it } from "vitest";
import { detectSingleTopicFunnel, FUNNEL_MIN_SEGMENTS } from "./funnel-guard";

describe("detectSingleTopicFunnel", () => {
  /** The production run of 2026-07-21, as numbers: 0 existing topics, 47 segments, 1 target. */
  it("fires on the recorded over-merge shape", () => {
    const note = detectSingleTopicFunnel({
      existingTopicCount: 0,
      routedSegmentCount: 47,
      mergeTargetCount: 1,
    });
    expect(note).not.toBeNull();
    expect(note).toContain("funnelled into a single topic");
    expect(note).toContain("47 sections → 1 topic");
    expect(note).toContain("likely under-split");
  });

  it("fires at exactly the segment floor", () => {
    expect(
      detectSingleTopicFunnel({
        existingTopicCount: 0,
        routedSegmentCount: FUNNEL_MIN_SEGMENTS,
        mergeTargetCount: 1,
      }),
    ).not.toBeNull();
  });

  it("stays silent one segment below the floor — a short document can be one topic", () => {
    expect(
      detectSingleTopicFunnel({
        existingTopicCount: 0,
        routedSegmentCount: FUNNEL_MIN_SEGMENTS - 1,
        mergeTargetCount: 1,
      }),
    ).toBeNull();
  });

  it("stays silent on a healthy split", () => {
    expect(
      detectSingleTopicFunnel({
        existingTopicCount: 0,
        routedSegmentCount: 47,
        mergeTargetCount: 5,
      }),
    ).toBeNull();
  });

  it("stays silent on a grown index — one document expanding one topic is the invariant", () => {
    expect(
      detectSingleTopicFunnel({
        existingTopicCount: 9,
        routedSegmentCount: 47,
        mergeTargetCount: 1,
      }),
    ).toBeNull();
  });

  it("stays silent on an empty document", () => {
    expect(
      detectSingleTopicFunnel({
        existingTopicCount: 0,
        routedSegmentCount: 0,
        mergeTargetCount: 0,
      }),
    ).toBeNull();
  });
});
