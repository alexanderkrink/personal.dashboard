import { describe, expect, it } from "vitest";
import { computeDocumentOutcome, outcomeMessage, type TopicMergeOutcome } from "./outcome";

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
