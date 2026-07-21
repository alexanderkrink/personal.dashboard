import { describe, expect, it } from "vitest";
import {
  computeDocumentOutcome,
  countNewestFlagged,
  outcomeMessage,
  type TopicMergeOutcome,
} from "./outcome";

const merged = (topicKey: string, needsReview = false): TopicMergeOutcome => ({
  topicKey,
  status: "merged",
  needsReview,
});

const failed = (topicKey: string, error = "boom"): TopicMergeOutcome => ({
  topicKey,
  status: "failed",
  error,
});

describe("computeDocumentOutcome", () => {
  it("is ready when every merge succeeded", () => {
    const outcome = computeDocumentOutcome({ topicOutcomes: [merged("a"), merged("b")] });

    expect(outcome.status).toBe("ready");
    expect(outcome.failedTopics).toEqual([]);
    expect(outcome.mergedCount).toBe(2);
    expect(outcomeMessage(outcome)).toBeNull();
  });

  it("is partial when some merges failed, and carries the retry set", () => {
    const outcome = computeDocumentOutcome({
      topicOutcomes: [merged("a"), failed("b", "429 from Anthropic"), merged("c")],
    });

    expect(outcome.status).toBe("partial");
    expect(outcome.failedTopics).toEqual([{ topicKey: "b", error: "429 from Anthropic" }]);
    expect(outcome.mergedCount).toBe(2);
  });

  /**
   * The case PLAN's wording does not cover. "Some failed → partial" read literally makes an
   * all-failed document `partial`, which promises "usable, with gaps" for a document that
   * contributed nothing — and all-failed is exactly what a systematic fault looks like.
   */
  it("is failed — not partial — when every merge failed", () => {
    const outcome = computeDocumentOutcome({ topicOutcomes: [failed("a"), failed("b")] });

    expect(outcome.status).toBe("failed");
    expect(outcome.failedTopics).toHaveLength(2);
  });

  it("is ready when there was nothing to merge", () => {
    // An extraction that produced no routable segments succeeded at its job.
    expect(computeDocumentOutcome({ topicOutcomes: [] }).status).toBe("ready");
  });

  it("degrades to partial on a non-topic failure such as embedding", () => {
    const outcome = computeDocumentOutcome({ topicOutcomes: [merged("a")], degraded: true });

    expect(outcome.status).toBe("partial");
    // The degradation is NOT a topic, so it must not enter the retry set.
    expect(outcome.failedTopics).toEqual([]);
  });

  it("degrades an empty run to partial too", () => {
    expect(computeDocumentOutcome({ topicOutcomes: [], degraded: true }).status).toBe("partial");
  });

  it("counts merges that still needed review after the auto-retry", () => {
    const outcome = computeDocumentOutcome({
      topicOutcomes: [merged("a", true), merged("b"), merged("c", true)],
    });

    expect(outcome.status).toBe("ready");
    expect(outcome.needsReviewCount).toBe(2);
  });

  /**
   * §3 fix (2): an untrustworthy coverage map must downgrade the document, exactly like an
   * embedding degradation. On the wave7-section3 run, 4 of 8 planned topics evaporated and
   * the ONLY honest signal left was `coverage.trustworthy = false` — yet the document still
   * finalized `ready`, because this function never read coverage. It reads it now.
   */
  it("RED: downgrades to partial when coverage is untrustworthy, even with every merge clean", () => {
    const outcome = computeDocumentOutcome({
      topicOutcomes: [merged("a"), merged("b")],
      coverageUntrustworthy: true,
    });

    // Fails on the old signature: `coverageUntrustworthy` is ignored → 'ready'.
    expect(outcome.status).toBe("partial");
    // The verdict is NOT a topic, so it must not enter the retry set — same rule as degraded.
    expect(outcome.failedTopics).toEqual([]);
  });

  it("stays ready when coverage is trustworthy", () => {
    const outcome = computeDocumentOutcome({
      topicOutcomes: [merged("a"), merged("b")],
      coverageUntrustworthy: false,
    });

    expect(outcome.status).toBe("ready");
  });

  it("does not upgrade an all-failed document to partial on an untrustworthy map", () => {
    const outcome = computeDocumentOutcome({
      topicOutcomes: [failed("a"), failed("b")],
      coverageUntrustworthy: true,
    });

    expect(outcome.status).toBe("failed");
  });
});

describe("countNewestFlagged", () => {
  /**
   * §3 fix (4): the finalize "N flagged" note must count PERSISTED revisions, not the
   * in-process merge outcomes. This is the case the old count got wrong — two revisions
   * flagged AFTER the merge (a coverage gap, a deep-review conflict) while the merge outcomes
   * carried `needsReview: false`.
   */
  it("RED: counts topics flagged by revisions written after the merge (old count: 0)", () => {
    const rows = [
      // Topic a: merged clean at rev 0, then a coverage gap flagged it at rev 1.
      { topic_id: "a", revision: 0, needs_review: false },
      { topic_id: "a", revision: 1, needs_review: true },
      // Topic b: a deep-review conflict flagged it.
      { topic_id: "b", revision: 1, needs_review: true },
      // Topic c: merged clean, never flagged.
      { topic_id: "c", revision: 0, needs_review: false },
    ];

    // The old code read `needsReviewCount` off merge outcomes that were all `needsReview:false`.
    const oldCount = computeDocumentOutcome({
      topicOutcomes: [
        { topicKey: "a", status: "merged", needsReview: false },
        { topicKey: "b", status: "merged", needsReview: false },
        { topicKey: "c", status: "merged", needsReview: false },
      ],
    }).needsReviewCount;
    expect(oldCount).toBe(0);

    // The persisted-revision count is the honest 2.
    expect(countNewestFlagged(rows)).toBe(2);
    expect(` ${countNewestFlagged(rows)} flagged for review.`).toContain("2 flagged");
  });

  it("uses the NEWEST revision per topic — a resolved flag stops counting", () => {
    // Flagged at rev 1, then a later revision cleared it. The topic is no longer flagged.
    const rows = [
      { topic_id: "a", revision: 1, needs_review: true },
      { topic_id: "a", revision: 2, needs_review: false },
    ];
    expect(countNewestFlagged(rows)).toBe(0);
  });

  it("is zero on no revisions", () => {
    expect(countNewestFlagged([])).toBe(0);
  });
});

describe("outcomeMessage", () => {
  it("says nothing for a clean run", () => {
    expect(outcomeMessage(computeDocumentOutcome({ topicOutcomes: [merged("a")] }))).toBeNull();
  });

  it("names the retry count on a partial run", () => {
    const message = outcomeMessage(
      computeDocumentOutcome({ topicOutcomes: [merged("a"), failed("b")] }),
    );

    expect(message).toContain("1 of them");
    expect(message).toContain("Retry");
  });

  it("distinguishes a degraded-but-complete run from failed topics", () => {
    const message = outcomeMessage(
      computeDocumentOutcome({ topicOutcomes: [merged("a")], degraded: true }),
    );

    expect(message).toContain("search may lag");
  });

  it("never leaks a raw error string into the user-facing sentence", () => {
    const message = outcomeMessage(
      computeDocumentOutcome({
        topicOutcomes: [failed("a", "TypeError: Cannot read properties of undefined")],
      }),
    );

    expect(message).not.toContain("TypeError");
  });
});
