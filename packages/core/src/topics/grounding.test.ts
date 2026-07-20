import { describe, expect, it } from "vitest";
import { detectUngroundedContent, MAX_EXPANSION_RATIO, measureExpansion } from "./grounding";
import type { TopicPageLike } from "./page";

function page(overrides: Partial<TopicPageLike> = {}): TopicPageLike {
  return { summary: "s", notes: [], keyTerms: [], formulas: [], workedExamples: [], ...overrides };
}

/**
 * The literal text of the single segment the Wave 4 merge was given — page 2 of
 * `Sampling Distributions.pdf`, the "Topic Goals" slide. Shortened here, but faithful in the
 * one respect that matters: it states objectives in prose, mentions `$\bar{X}$` and
 * `$\hat{p}$` inline, and contains no displayed formula anywhere.
 */
const WAVE4_MERGE_INPUT = `[p.2] Topic Goals

After completing this chapter, you should be able to:
- Describe the properties of a sampling distribution
- Explain the sampling distribution of the sample mean $\\bar{X}$
- Apply the Central Limit Theorem
- Explain the sampling distribution of the sample proportion $\\hat{p}$
- Describe the sampling distribution of the sample variance
- Use the chi-square distribution
- Determine the required sample size`;

/** The six formulas the merge produced from that input. */
const WAVE4_FORMULAS = [
  { name: "Mean of the sampling distribution", latex: "\\mu_{\\bar{X}} = \\mu", sources: [] },
  { name: "Standard error", latex: "\\sigma_{\\bar{X}} = \\sigma/\\sqrt{n}", sources: [] },
  { name: "Finite population correction", latex: "\\sqrt{\\frac{N-n}{N-1}}", sources: [] },
  { name: "Mean of a proportion", latex: "\\mu_{\\hat{p}} = p", sources: [] },
  { name: "SE of a proportion", latex: "\\sqrt{\\frac{p(1-p)}{n}}", sources: [] },
  { name: "Chi-square", latex: "\\frac{(n-1)s^2}{\\sigma^2}", sources: [] },
];

describe("detectUngroundedContent — formulas with no source mathematics", () => {
  it("RED: flags the six Wave 4 formulas against the slide they were built from", () => {
    const findings = detectUngroundedContent({
      page: page({ formulas: WAVE4_FORMULAS }),
      sourceText: WAVE4_MERGE_INPUT,
      isNewTopic: true,
    });

    // The input had zero displayed formulas; the output had six. This is the check that
    // would have fired on the real run, and it needs no model to do it.
    const formulaFinding = findings.find((f) => f.kind === "formulas-without-source-math");
    expect(formulaFinding).toBeDefined();
    expect(formulaFinding?.detail).toContain("6 formulas");
    // …and it must say WHY, distinguishing bare inline symbols from a real derivation.
    expect(formulaFinding?.detail).toContain("only symbols mentioned inline in prose");
  });

  it("GREEN: accepts the same formulas when the source actually displays mathematics", () => {
    const findings = detectUngroundedContent({
      page: page({ formulas: WAVE4_FORMULAS }),
      sourceText: `[p.23] Standard Error\n\n$$\\sigma_{\\bar{X}} = \\frac{\\sigma}{\\sqrt{n}}$$`,
      isNewTopic: true,
    });

    expect(findings.filter((f) => f.kind === "formulas-without-source-math")).toEqual([]);
  });

  it("accepts \\begin{align} and \\[ as displayed mathematics too", () => {
    for (const source of ["\\[ x = y \\]", "\\begin{align} x &= y \\end{align}"]) {
      const findings = detectUngroundedContent({
        page: page({ formulas: WAVE4_FORMULAS }),
        sourceText: source,
        isNewTopic: true,
      });
      expect(findings.filter((f) => f.kind === "formulas-without-source-math")).toEqual([]);
    }
  });

  it("says 'at all' when the source has no mathematics of any kind", () => {
    const findings = detectUngroundedContent({
      page: page({ formulas: [WAVE4_FORMULAS[0] ?? { name: "", latex: "", sources: [] }] }),
      sourceText: "Plain prose about sampling, with no symbols.",
      isNewTopic: true,
    });

    expect(findings[0]?.detail).toContain("at all");
  });

  it("says nothing when the page states no formulas", () => {
    expect(
      detectUngroundedContent({
        page: page(),
        sourceText: WAVE4_MERGE_INPUT,
        isNewTopic: true,
      }),
    ).toEqual([]);
  });
});

describe("detectUngroundedContent — unanchored terms and examples", () => {
  it("RED: flags a key term whose name is nowhere in the source", () => {
    const findings = detectUngroundedContent({
      page: page({
        keyTerms: [
          { term: "Finite Population Correction", definition: "d", sources: [] },
          { term: "Central Limit Theorem", definition: "d", sources: [] },
        ],
      }),
      sourceText: WAVE4_MERGE_INPUT,
      isNewTopic: true,
    });

    // "Central Limit Theorem" IS on the objectives slide; the correction factor is not.
    expect(findings.map((f) => f.subject)).toEqual(["Finite Population Correction"]);
    expect(findings[0]?.kind).toBe("unanchored-key-term");
  });

  it("matches a term case- and whitespace-insensitively", () => {
    const findings = detectUngroundedContent({
      page: page({
        keyTerms: [{ term: "central   limit  THEOREM", definition: "d", sources: [] }],
      }),
      sourceText: WAVE4_MERGE_INPUT,
      isNewTopic: true,
    });

    expect(findings).toEqual([]);
  });

  it("declines to run on an UPDATE, where the page carries other documents' material", () => {
    const findings = detectUngroundedContent({
      page: page({
        formulas: WAVE4_FORMULAS,
        keyTerms: [{ term: "Anything At All", definition: "d", sources: [] }],
      }),
      sourceText: WAVE4_MERGE_INPUT,
      isNewTopic: false,
    });

    // Reporting inherited content as ungrounded would be a false accusation.
    expect(findings).toEqual([]);
  });
});

describe("measureExpansion", () => {
  it("RED: flags the Wave 4 ratio — 12,296 characters written from 577", () => {
    const measurement = measureExpansion({
      sourceText: "x".repeat(577),
      page: page({ summary: "y".repeat(12_296) }),
      isNewTopic: true,
    });

    expect(measurement.sourceChars).toBe(577);
    expect(measurement.ratio).toBeGreaterThan(MAX_EXPANSION_RATIO);
    expect(measurement.implausible).toBe(true);
    expect(measurement.detail).toContain("is not summarising it");
  });

  it("GREEN: accepts a page a few times the size of a real slide run", () => {
    const measurement = measureExpansion({
      sourceText: "x".repeat(9_000),
      page: page({ summary: "y".repeat(18_000) }),
      isNewTopic: true,
    });

    expect(measurement.implausible).toBe(false);
    expect(measurement.detail).toBeNull();
  });

  it("RED: flags a source too thin to ground anything, whatever the ratio", () => {
    const measurement = measureExpansion({
      sourceText: "x".repeat(120),
      page: page({ summary: "y".repeat(300) }),
      isNewTopic: true,
    });

    expect(measurement.ratio).toBeLessThan(MAX_EXPANSION_RATIO);
    expect(measurement.implausible).toBe(true);
  });

  it("does not judge an UPDATE, whose page is mostly prior material", () => {
    const measurement = measureExpansion({
      sourceText: "x".repeat(577),
      page: page({ summary: "y".repeat(12_296) }),
      isNewTopic: false,
    });

    expect(measurement.implausible).toBe(false);
  });

  it("treats an empty source as infinitely implausible rather than dividing by zero", () => {
    const measurement = measureExpansion({
      sourceText: "",
      page: page({ summary: "y" }),
      isNewTopic: true,
    });

    expect(measurement.ratio).toBe(Number.POSITIVE_INFINITY);
    expect(measurement.implausible).toBe(true);
  });
});
