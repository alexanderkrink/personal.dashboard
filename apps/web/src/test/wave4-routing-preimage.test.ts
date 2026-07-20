/**
 * Preimage reconstruction against the frozen Wave 4 failure corpus.
 *
 * `input_hash = sha256(`${prompt.id}@${prompt.version}\n${rendered}`)` (`runtime.ts`), and
 * `ai_generations` stored that hash for every call in the failing run. The hash is therefore
 * a cryptographic receipt for the exact prompt text each model saw — the only evidence in
 * the corpus that survives the absence of a stored response body.
 *
 * These tests reconstruct the prompts from the frozen extraction and assert the hashes match
 * the recorded ones. They are the reason the Wave 5 diagnosis is a measurement rather than an
 * inference: they prove that 48 segments reached the router and exactly one reached the merge.
 */

import { createHash } from "node:crypto";
import {
  EMPTY_TOPIC_PAGE,
  renderMergeSegments,
  renderRoutableSegments,
  renderTopicIndex,
  topicMergePrompt,
  topicRoutingPrompt,
} from "@study/ai";
import { type Segment, segmentExtraction } from "@study/core";
import { expect, it } from "vitest";
import { describeWithWave4Failure, loadWave4Failure } from "./wave4-failure-fixture";

/** The recorded `topic-routing` `input_hash` for the failing run. */
const RECORDED_ROUTING_HASH = "cf0ff73796349e6979cd7e9899fcd6fa225f3cc0d3f8eac0d9b5786e2043210f";
/** The recorded `topic-merge` `input_hash` for the failing run. */
const RECORDED_MERGE_HASH = "494b858ecd175702d2663b8fef2c368793a62a703c9935abca043f20cc5f146e";

const COURSE_TITLE = "PROBABILITY & STATISTICS FOR DATA MANAGEMENT AND ANALYSIS";
const DOCUMENT_LABEL = "Sampling Distributions.pdf";
const SESSION_LABEL = "Chapter 6";
const DOCUMENT_ID = "2b33fe5b-0c05-4c15-9f56-d98cd3f00c31";

function inputHash(promptId: string, version: number, rendered: string): string {
  return createHash("sha256").update(`${promptId}@${version}\n${rendered}`, "utf8").digest("hex");
}

/** Re-runs the real segmenter over the frozen extraction, exactly as the failing run did. */
export function replaySegmentation(): readonly Segment[] {
  const fixture = loadWave4Failure();
  const sourceUnits = fixture.extractionEnvelope.sourceUnits;
  return segmentExtraction({
    pages: fixture.extraction.pages,
    headings: fixture.extraction.headings,
    skipped: fixture.extraction.skipped,
    sourceUnits: typeof sourceUnits === "number" ? sourceUnits : undefined,
  }).segments;
}

describeWithWave4Failure("wave4 failure — prompt preimage reconstruction", () => {
  it("segments the frozen extraction into 48 one-page segments", () => {
    const segments = replaySegmentation();
    expect(segments).toHaveLength(48);
    expect(segments.every((segment) => segment.pages.length === 1)).toBe(true);
    expect(segments[0]?.pages).toEqual([2]);
  });

  it("reproduces the recorded routing input_hash from ALL 48 segments", () => {
    const segments = replaySegmentation();
    const rendered = topicRoutingPrompt.render({
      courseTitle: COURSE_TITLE,
      topicIndex: renderTopicIndex([]),
      documentLabel: DOCUMENT_LABEL,
      sessionLabel: SESSION_LABEL,
      segments: renderRoutableSegments(
        segments.map((segment) => ({
          key: segment.key,
          title: segment.title,
          markdown: segment.markdown,
          candidates: [],
        })),
      ),
    });

    expect(inputHash("topic-routing", topicRoutingPrompt.version, rendered)).toBe(
      RECORDED_ROUTING_HASH,
    );
  });

  it("does NOT reproduce the routing hash from one segment — the router saw all 48", () => {
    const segments = replaySegmentation();
    const rendered = topicRoutingPrompt.render({
      courseTitle: COURSE_TITLE,
      topicIndex: renderTopicIndex([]),
      documentLabel: DOCUMENT_LABEL,
      sessionLabel: SESSION_LABEL,
      segments: renderRoutableSegments(
        segments.slice(0, 1).map((segment) => ({
          key: segment.key,
          title: segment.title,
          markdown: segment.markdown,
          candidates: [],
        })),
      ),
    });

    expect(inputHash("topic-routing", topicRoutingPrompt.version, rendered)).not.toBe(
      RECORDED_ROUTING_HASH,
    );
  });

  it("reproduces the recorded merge input_hash from seg-1 ALONE — one of 48 reached the merge", () => {
    const segments = replaySegmentation();
    const rendered = topicMergePrompt.render({
      courseTitle: COURSE_TITLE,
      topicTitle: "Sampling Distributions",
      isNewTopic: true,
      currentPage: JSON.stringify(EMPTY_TOPIC_PAGE),
      currentBlockKeys: "(the page has no blocks yet)",
      documentId: DOCUMENT_ID,
      documentLabel: DOCUMENT_LABEL,
      sessionLabel: SESSION_LABEL,
      segments: renderMergeSegments(segments.slice(0, 1)),
    });

    expect(inputHash("topic-merge", topicMergePrompt.version, rendered)).toBe(RECORDED_MERGE_HASH);
  });

  it("does NOT reproduce the merge hash from all 48 segments", () => {
    const segments = replaySegmentation();
    const rendered = topicMergePrompt.render({
      courseTitle: COURSE_TITLE,
      topicTitle: "Sampling Distributions",
      isNewTopic: true,
      currentPage: JSON.stringify(EMPTY_TOPIC_PAGE),
      currentBlockKeys: "(the page has no blocks yet)",
      documentId: DOCUMENT_ID,
      documentLabel: DOCUMENT_LABEL,
      sessionLabel: SESSION_LABEL,
      segments: renderMergeSegments(segments),
    });

    expect(inputHash("topic-merge", topicMergePrompt.version, rendered)).not.toBe(
      RECORDED_MERGE_HASH,
    );
  });

  it("the single merged segment contains no display math at all", () => {
    const segments = replaySegmentation();
    const merged = segments[0];
    expect(merged?.markdown).not.toMatch(/\$\$/);
    // …while the produced page carries six full LaTeX formulas.
    expect(loadWave4Failure().topicPage.formulas).toHaveLength(6);
  });
});
