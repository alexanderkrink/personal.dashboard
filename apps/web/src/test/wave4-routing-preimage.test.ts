/**
 * The Wave 4 preimage receipts.
 *
 * `input_hash = sha256(`${prompt.id}@${prompt.version}\n${rendered}`)` (`runtime.ts`), and
 * `ai_generations` stored that hash for every call in the failing run. The hash is therefore
 * a cryptographic receipt for the exact prompt text each model saw — the only evidence in
 * the corpus that survives the absence of a stored response body. It is what proves that 48
 * segments reached the router and exactly one reached the merge.
 *
 * ## Why the receipts stand on frozen bytes, not on the live templates
 *
 * Wave 5 originally reconstructed both preimages by calling today's `definePrompt` templates
 * and checking the hash. That works exactly until somebody edits a prompt — and then the
 * test fails, and the obvious repair is to update the expected hash, which would erase the
 * wave's primary evidence while looking like routine maintenance.
 *
 * Worse, the coupling made the evidence *hostage*: Wave 5 declined a set of prompt-text
 * improvements specifically to keep these hashes reproducing, and then changed what
 * `topic-merge@1` actually sent the model anyway — through the Zod output schema, which
 * `input_hash` does not cover. The receipt was preserved in letter and spent in substance.
 *
 * So the rendered strings are frozen on disk (`loadPreimage`) and the receipts are asserted
 * against those. The templates are now free to move; {@link driftSuite} below reports when
 * they do.
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
import { computeCoverage, type Segment, segmentExtraction } from "@study/core";
import { expect, it } from "vitest";
import { describeWithWave4Failure, loadPreimage, loadWave4Failure } from "./wave4-failure-fixture";

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

describeWithWave4Failure("wave4 receipts — the frozen preimages", () => {
  it("the frozen routing preimage hashes to the recorded topic-routing input_hash", () => {
    expect(inputHash("topic-routing", 1, loadPreimage("topic-routing-v1"))).toBe(
      RECORDED_ROUTING_HASH,
    );
  });

  it("the frozen merge preimage hashes to the recorded topic-merge input_hash", () => {
    expect(inputHash("topic-merge", 1, loadPreimage("topic-merge-v1"))).toBe(RECORDED_MERGE_HASH);
  });

  /*
   * The discrimination, stated as facts about the exact bytes each model received rather
   * than as hash mismatches against counterfactual renderings. Stronger evidence and, unlike
   * a mismatch, it cannot be satisfied by an unrelated change that happens to alter a hash.
   */
  it("the router was sent all 48 segments", () => {
    const preimage = loadPreimage("topic-routing-v1");
    for (let n = 1; n <= 48; n += 1) {
      expect(preimage).toContain(`segmentKey: seg-${n}`);
    }
    expect(preimage).not.toContain("segmentKey: seg-49");
  });

  it("the merge was sent page 2 and nothing else", () => {
    const preimage = loadPreimage("topic-merge-v1");
    const pageMarkers = [...preimage.matchAll(/\[p\.(\d+)\]/g)].map((m) => Number(m[1]));

    // 48 pages were routed. One arrived.
    expect([...new Set(pageMarkers)]).toEqual([2]);
  });

  it("the merge input contained no display mathematics, and the page it produced had six formulas", () => {
    expect(loadPreimage("topic-merge-v1")).not.toMatch(/\$\$/);
    expect(loadWave4Failure().topicPage.formulas).toHaveLength(6);
  });

  it("segments the frozen extraction into 48 one-page segments", () => {
    const segments = replaySegmentation();
    expect(segments).toHaveLength(48);
    expect(segments.every((segment) => segment.pages.length === 1)).toBe(true);
    expect(segments[0]?.pages).toEqual([2]);
  });
});

/**
 * Drift, reported rather than hidden.
 *
 * These compare TODAY's templates against the frozen preimages. A failure here is never a
 * reason to touch a receipt above — it means a template moved, and the response is to record
 * a NEW preimage under its NEW version, leaving the old one exactly as it is.
 */
describeWithWave4Failure("wave4 receipts — live template drift", () => {
  it("topic-routing has moved past the receipt, and moved its version with it", () => {
    // Wave 5 deliberately held F6 (the routing prompt's empty-index carve-out): the Wave 4
    // router did not misbehave, so there was nothing for a prompt edit to fix — and this
    // test asserted `version === 1` to pin that decision. On 2026-07-21 the carve-out's
    // absence WAS the failure, live: v1's unconditional assign-bias met an empty index and
    // funnelled 47 segments into one create (the wave6-overmerge corpus). Wave 6 shipped
    // the empty-index mode as v2. The v1 receipt above stands on the frozen preimage,
    // exactly as this suite's header says it must.
    expect(topicRoutingPrompt.version).toBeGreaterThan(1);

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

    expect(rendered).not.toBe(loadPreimage("topic-routing-v1"));
    expect(inputHash("topic-routing", topicRoutingPrompt.version, rendered)).not.toBe(
      RECORDED_ROUTING_HASH,
    );
  });

  it("topic-merge has moved past the receipt, and moved its version with it", () => {
    // v2 added the "covers pp. X–Y" header to `renderMergeSegments` and made rule 2 of
    // `TOPIC_MERGE_SYSTEM` page-granular. The receipt above belongs to v1 and stays there.
    expect(topicMergePrompt.version).toBeGreaterThan(1);

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

    expect(rendered).not.toBe(loadPreimage("topic-merge-v1"));
    expect(inputHash("topic-merge", topicMergePrompt.version, rendered)).not.toBe(
      RECORDED_MERGE_HASH,
    );
  });
});

/**
 * F4's acceptance condition, stated against the real artifact rather than a reproduction of
 * it: the coverage numbers this document actually stored must come back untrustworthy when
 * fed through the predicate Wave 5 shipped.
 */
describeWithWave4Failure("wave4 failure — the recorded coverage, re-judged", () => {
  it("recorded trustworthy: true with no warnings on 1 of 48 pages mapped", () => {
    const { coverage } = loadWave4Failure();
    expect(coverage.trustworthy).toBe(true);
    expect(coverage.warnings).toEqual([]);
    expect(coverage.pagesMapped).toBe(1);
    expect(coverage.pagesUnmapped).toBe(47);
  });

  it("RED: the same inputs are NOT trustworthy under the Wave 5 predicate", () => {
    const fixture = loadWave4Failure();
    const sourceUnits = fixture.extractionEnvelope.sourceUnits;

    const recomputed = computeCoverage({
      sourceUnits: typeof sourceUnits === "number" ? sourceUnits : 0,
      extractedPages: fixture.extraction.pages.map((page) => page.page),
      skipped: fixture.extraction.skipped,
      mappedPages: fixture.topicSources.flatMap((row) => row.locators.map((l) => l.page)),
      topicCount: fixture.coverage.topicCount,
    });

    // Same document, same extraction, same `topic_sources` — opposite verdict.
    expect(recomputed.pagesMapped).toBe(1);
    expect(recomputed.pagesUnmapped).toBe(47);
    expect(recomputed.trustworthy).toBe(false);
    expect(recomputed.warnings.join(" ")).toMatch(/cited by any topic/);
  });
});
