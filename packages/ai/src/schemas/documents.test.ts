import { describe, expect, it } from "vitest";
import {
  documentExtractionSchema,
  EXTRACTION_FIDELITIES,
  EXTRACTION_ROUTES,
  extractionFidelitySchema,
  fidelityForRoute,
  storedExtractionSchema,
} from "./documents";

/**
 * The document-extraction contract (PLAN §4.1/§4.2).
 *
 * One schema serves both branches, so the tests that matter are the ones proving the shape
 * is genuinely branch-independent and that the completeness fields are *required* rather
 * than conveniently optional. A schema whose `skipped` is optional turns "declared
 * omission" back into "silent loss" without anyone editing a prompt.
 */

/** A minimal valid extraction. Every array present, because every array is required. */
const valid = {
  sessionLabel: "Session 1",
  summary: "An introduction to marketing fundamentals.",
  pages: [{ page: 1, title: "What is marketing?", markdown: "Kotler's definition…" }],
  headings: [{ text: "What is marketing?", level: 1, page: 1 }],
  definitions: [{ term: "Marketing", definition: "The process by which…", page: 1 }],
  formulas: [],
  workedExamples: [],
  examSignals: [{ quote: "this will be on the exam", page: 4, topic: "the 5 C analysis" }],
  skipped: [{ fromPage: 2, toPage: 3, reason: "instructor biography" }],
};

describe("documentExtractionSchema", () => {
  it("accepts a complete extraction", () => {
    expect(documentExtractionSchema.parse(valid)).toMatchObject({ sessionLabel: "Session 1" });
  });

  it("accepts a null sessionLabel — declining is a valid answer", () => {
    expect(
      documentExtractionSchema.parse({ ...valid, sessionLabel: null }).sessionLabel,
    ).toBeNull();
  });

  /**
   * The completeness ledger is only a ledger if it is mandatory. An optional `skipped`
   * would let a model that abridged a deck return nothing at all and still validate.
   */
  it("requires `skipped` rather than defaulting it away", () => {
    const { skipped: _skipped, ...withoutSkipped } = valid;
    expect(documentExtractionSchema.safeParse(withoutSkipped).success).toBe(false);
  });

  it("requires `pages`, `examSignals` and the structure arrays", () => {
    for (const key of [
      "pages",
      "examSignals",
      "headings",
      "definitions",
      "formulas",
      "workedExamples",
    ] as const) {
      const { [key]: _dropped, ...rest } = valid;
      expect(documentExtractionSchema.safeParse(rest).success, `${key} should be required`).toBe(
        false,
      );
    }
  });

  it("accepts an empty skipped array — that is a claim, and a legal one", () => {
    expect(documentExtractionSchema.parse({ ...valid, skipped: [] }).skipped).toEqual([]);
  });

  /** An exam signal without its page cannot be checked against the document. */
  it("rejects an exam signal missing its page", () => {
    const result = documentExtractionSchema.safeParse({
      ...valid,
      examSignals: [{ quote: "on the exam", topic: "elasticity" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects page numbers below 1 — pages are 1-based everywhere", () => {
    expect(
      documentExtractionSchema.safeParse({
        ...valid,
        pages: [{ page: 0, title: null, markdown: "x" }],
      }).success,
    ).toBe(false);
  });

  it("rejects a non-integer page", () => {
    expect(
      documentExtractionSchema.safeParse({
        ...valid,
        pages: [{ page: 1.5, title: null, markdown: "x" }],
      }).success,
    ).toBe(false);
  });
});

describe("extraction fidelity and route", () => {
  it("has exactly the two fidelities the column's check constraint allows", () => {
    expect([...EXTRACTION_FIDELITIES]).toEqual(["text-only", "visual"]);
    expect(extractionFidelitySchema.safeParse("visual").success).toBe(true);
    expect(extractionFidelitySchema.safeParse("partial").success).toBe(false);
  });

  it("names all three routes", () => {
    expect([...EXTRACTION_ROUTES]).toEqual(["pdf-native", "pptx-xml", "pptx-converted-pdf"]);
  });

  /**
   * The §4.2 table, asserted directly. Only the PPTX XML branch is `text-only`: it is the
   * one route where the slide images are never looked at.
   */
  it("maps every route to the fidelity §4.2 specifies", () => {
    expect(fidelityForRoute("pdf-native")).toBe("visual");
    expect(fidelityForRoute("pptx-xml")).toBe("text-only");
    expect(fidelityForRoute("pptx-converted-pdf")).toBe("visual");
  });

  it("maps every declared route — no route is left without a fidelity", () => {
    for (const route of EXTRACTION_ROUTES) {
      expect(EXTRACTION_FIDELITIES).toContain(fidelityForRoute(route));
    }
  });
});

describe("storedExtractionSchema", () => {
  /**
   * Parsed on the way back OUT of the database as well as in: a stored artifact is an
   * external input to every future version of this code.
   */
  it("round-trips what the step writes to documents.extraction", () => {
    const stored = {
      route: "pptx-converted-pdf",
      fidelity: "visual",
      sourceUnits: 32,
      wordsPerSlide: 22.6,
      extraction: valid,
    };
    expect(storedExtractionSchema.parse(stored)).toMatchObject({ route: "pptx-converted-pdf" });
  });

  it("allows a null wordsPerSlide — the PDF route has no such statistic", () => {
    expect(
      storedExtractionSchema.parse({
        route: "pdf-native",
        fidelity: "visual",
        sourceUnits: 27,
        wordsPerSlide: null,
        extraction: valid,
      }).wordsPerSlide,
    ).toBeNull();
  });

  it("rejects a fidelity the column would reject", () => {
    expect(
      storedExtractionSchema.safeParse({
        route: "pdf-native",
        fidelity: "unknown",
        sourceUnits: 27,
        wordsPerSlide: null,
        extraction: valid,
      }).success,
    ).toBe(false);
  });
});
