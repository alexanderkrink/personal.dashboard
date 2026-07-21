import { describe, expect, it } from "vitest";
import {
  countSignalsByTopic,
  type MappableSignal,
  type MappableTopic,
  mapExamSignal,
  mapExamSignals,
} from "./exam-signal-mapping";

/**
 * §9(a)'s page-first / fuzzy-fallback mapping. Both branches are exercised, plus the
 * unmappable case — the one that must not crash and must not misattribute.
 */

const ELASTICITY: MappableTopic = {
  topicId: "topic-elasticity",
  title: "Price Elasticity of Demand",
  summary: "How quantity demanded responds to price changes; elastic vs inelastic goods.",
  sources: [{ documentId: "doc-lecture-3", pages: [4, 5, 6] }],
};

const REGRESSION: MappableTopic = {
  topicId: "topic-regression",
  title: "Linear Regression",
  summary: "Fitting a line to data; ordinary least squares, residuals and R-squared.",
  sources: [{ documentId: "doc-lecture-9", pages: [4, 5] }],
};

const TOPICS = [ELASTICITY, REGRESSION];

function signal(overrides: Partial<MappableSignal>): MappableSignal {
  return {
    quote: "this will be on the exam",
    page: 5,
    label: "something",
    documentId: "doc-lecture-3",
    ...overrides,
  };
}

describe("mapExamSignal — page match (branch 1)", () => {
  // RED against removing the document scope from the page match (drop the
  // `source.documentId === signal.documentId` clause): page 5 then also matches REGRESSION's
  // page 5 in a DIFFERENT document, and the single-match assertion below breaks.
  it("maps a signal to the topic whose source covers its (document, page)", () => {
    const result = mapExamSignal(signal({ page: 5, documentId: "doc-lecture-3" }), TOPICS);
    expect(result.method).toBe("page");
    expect(result.topicId).toBe("topic-elasticity");
  });

  it("does not let a page number leak across documents", () => {
    // Page 5 exists in BOTH documents, but this signal is from lecture 9 → regression only.
    const result = mapExamSignal(signal({ page: 5, documentId: "doc-lecture-9" }), TOPICS);
    expect(result.method).toBe("page");
    expect(result.topicId).toBe("topic-regression");
  });

  it("disambiguates two topics on the same page by label, still as a page hit", () => {
    const shared: MappableTopic = {
      topicId: "topic-shared",
      title: "Regression Diagnostics",
      summary: "Residual plots and leverage for a fitted regression.",
      sources: [{ documentId: "doc-lecture-3", pages: [5] }],
    };
    const result = mapExamSignal(
      signal({ page: 5, documentId: "doc-lecture-3", label: "residual diagnostics regression" }),
      [ELASTICITY, shared],
    );
    expect(result.method).toBe("page");
    expect(result.topicId).toBe("topic-shared");
  });
});

describe("mapExamSignal — fuzzy fallback (branch 2)", () => {
  // RED against removing the fuzzy fallback (return unmapped whenever no page matches): this
  // signal is on an unsourced page, so only the label saves it — the assertion goes red.
  it("falls back to label/summary overlap when no source covers the page", () => {
    const result = mapExamSignal(
      signal({ page: 99, documentId: "doc-lecture-3", label: "price elasticity" }),
      TOPICS,
    );
    expect(result.method).toBe("fuzzy");
    expect(result.topicId).toBe("topic-elasticity");
  });
});

describe("mapExamSignal — unmappable (branch 3)", () => {
  // RED against a fuzzy match with no threshold (drop `score >= FUZZY_MATCH_THRESHOLD`): this
  // label shares exactly ONE stray token ("price") out of six with the elasticity topic —
  // score 1/6 ≈ 0.167, a real but below-threshold overlap. Without the threshold that stray
  // token is enough to attach the signal to the wrong topic, and the null assertion breaks.
  it("leaves a barely-overlapping signal UNMAPPED rather than guessing on a stray token", () => {
    const result = mapExamSignal(
      signal({
        page: 99,
        documentId: "doc-lecture-3",
        label: "xylophone quokka zeppelin marmot narwhal price",
        quote: "",
      }),
      TOPICS,
    );
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(0.18);
    expect(result.method).toBe("unmapped");
    expect(result.topicId).toBeNull();
  });

  it("leaves a signal with no token overlap at all UNMAPPED", () => {
    const result = mapExamSignal(
      signal({
        page: 99,
        documentId: "doc-lecture-3",
        label: "xylophone quokka zeppelin",
        quote: "",
      }),
      TOPICS,
    );
    expect(result.method).toBe("unmapped");
    expect(result.topicId).toBeNull();
  });

  it("does not crash on empty topic and signal text", () => {
    const result = mapExamSignal(
      signal({ page: 1, documentId: "doc-x", label: "", quote: "" }),
      [],
    );
    expect(result.topicId).toBeNull();
    expect(result.method).toBe("unmapped");
  });
});

describe("countSignalsByTopic", () => {
  it("counts mapped signals per topic and drops the unmapped", () => {
    const mappings = mapExamSignals(
      [
        signal({ page: 5, documentId: "doc-lecture-3" }), // → elasticity (page)
        signal({ page: 4, documentId: "doc-lecture-9" }), // → regression (page)
        signal({ page: 99, documentId: "doc-lecture-3", label: "price elasticity" }), // → elasticity (fuzzy)
        signal({ page: 99, documentId: "doc-x", label: "zzz nonsense", quote: "" }), // → unmapped
      ],
      TOPICS,
    );
    const counts = countSignalsByTopic(mappings);
    expect(counts.get("topic-elasticity")).toBe(2);
    expect(counts.get("topic-regression")).toBe(1);
    // The unmapped signal is attributed to nobody.
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(3);
  });
});
