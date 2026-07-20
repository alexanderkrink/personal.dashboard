/**
 * Characterisation of the recorded Wave 4 failure.
 *
 * These tests assert what production ACTUALLY produced on 2026-07-20 — including the parts
 * that are wrong. They are the red half of the structural rule: the corpus that any new
 * grounding guard must be shown failing against before it is shown passing.
 *
 * They are deliberately written to keep passing after the pipeline is fixed, because they
 * assert against the frozen JSON on disk, not against live code. What they buy is a precise,
 * executable statement of the defect, so Agent 1 cannot fix the wrong thing.
 */

import { expect, it } from "vitest";
import {
  citedPages,
  describeWithWave4Failure,
  extractedPages,
  loadWave4Failure,
  WAVE4_COLLAPSED_PAGE,
  WAVE4_DOCUMENT_ID,
} from "./wave4-failure-fixture";

describeWithWave4Failure("wave 4 failure corpus", () => {
  it("loads, and the extraction unwraps from its envelope", () => {
    const f = loadWave4Failure();
    expect(f.extractionEnvelope).toMatchObject({
      route: "pdf-native",
      fidelity: "visual",
      sourceUnits: 54,
    });
    expect(f.extraction.pages.length).toBe(48);
  });

  // ── The extraction is NOT the problem ──────────────────────────────────────
  //
  // The briefing for this wave described the failure as "six formulas that appear nowhere in
  // the source material". These three tests disprove that. Every formula on the topic page
  // is present in the deck, with a page number, in the extraction.

  it("extracted 48 of 54 pages, spanning 2 to 53", () => {
    const pages = extractedPages(loadWave4Failure().extraction);
    expect(pages.length).toBe(48);
    expect(Math.min(...pages)).toBe(2);
    expect(Math.max(...pages)).toBe(53);
  });

  it("extracted 11 formulas, each carrying its own page citation", () => {
    const { formulas } = loadWave4Failure().extraction;
    expect(formulas.length).toBe(11);
    expect(formulas.every((x) => x.page >= 2 && x.page <= 53)).toBe(true);
    expect([...new Set(formulas.map((x) => x.page))].sort((a, b) => a - b)).toEqual([
      17, 18, 22, 24, 37, 38, 39, 44, 45, 46,
    ]);
  });

  it("every formula on the topic page is supported somewhere in the extraction", () => {
    const f = loadWave4Failure();
    // Match on a distinctive fragment rather than exact LaTeX: the merge legitimately
    // reformats (`E(\hat{p}) = P` on p.38 becomes `\mu_{\hat{p}} = p`), so string equality
    // would report a grounding failure that is really a notation difference.
    const haystack = [
      ...f.extraction.formulas.map((x) => x.latex),
      ...f.extraction.pages.map((p) => p.markdown),
    ]
      .join("\n")
      .replace(/\s+/g, "");

    const supportedBy: Record<string, string> = {
      "Mean of the sampling distribution of the sample mean": "\\mu_{\\bar{X}}=\\mu",
      "Standard error of the sample mean": "\\frac{\\sigma}{\\sqrt{n}}",
      "Finite population correction factor": "\\frac{N-n}{N-1}",
      "Mean of the sampling distribution of the sample proportion": "E(\\hat{p})=P",
      "Standard error of the sample proportion": "\\frac{P(1-P)}{n}",
      "Sampling distribution of the sample variance": "\\frac{(n-1)s^2}{\\sigma^2}",
    };

    for (const formula of f.topicPage.formulas) {
      const needle = supportedBy[formula.name];
      expect(needle, `no support mapping for “${formula.name}”`).toBeDefined();
      expect(haystack, `“${formula.name}” unsupported`).toContain(needle);
    }
  });

  // ── The actual defect: citation collapse ───────────────────────────────────

  it("🔴 collapses all 20 citations onto page 2, the objectives slide", () => {
    const f = loadWave4Failure();
    const pages = citedPages(f.topicPage);

    expect(pages.length).toBe(20);
    expect(new Set(pages)).toEqual(new Set([WAVE4_COLLAPSED_PAGE]));
    expect(f.topicSources[0]?.locators).toEqual([{ page: WAVE4_COLLAPSED_PAGE }]);
  });

  it("🔴 cites 1 of the 48 pages it read", () => {
    const f = loadWave4Failure();
    const cited = new Set(citedPages(f.topicPage));
    const read = new Set(extractedPages(f.extraction));

    expect(cited.size).toBe(1);
    expect(read.size).toBe(48);
    expect([...read].filter((p) => !cited.has(p)).length).toBe(47);
  });

  it("🔴 chunks span the whole deck, so the pages were available to cite", () => {
    const f = loadWave4Failure();
    const pages = f.chunks.map((c) => c.locator.page);
    expect(f.chunks.length).toBe(26);
    expect(Math.min(...pages)).toBe(2);
    expect(Math.max(...pages)).toBeGreaterThanOrEqual(50);
  });

  it("🔴 the merge was starved: 4,396 input tokens for an ~8K-token extraction", () => {
    const merge = loadWave4Failure().generations.find((g) => g.job === "topic-merge");
    expect(merge?.input_tokens).toBe(4396);
  });

  // ── Nothing complained ─────────────────────────────────────────────────────

  it("🔴 reports trustworthy: true with 47 unmapped pages and no warnings", () => {
    const { coverage } = loadWave4Failure();
    expect(coverage.trustworthy).toBe(true);
    expect(coverage.warnings).toEqual([]);
    expect(coverage.pagesMapped).toBe(1);
    expect(coverage.pagesUnmapped).toBe(47);
    expect(coverage.pagesTotal).toBe(54);
  });

  it("🔴 emitted 12 events, every one level=info (D13)", () => {
    const { events } = loadWave4Failure();
    expect(events.length).toBe(12);
    expect(events.filter((e) => e.level !== "info")).toEqual([]);
    expect(events.at(-1)?.detail.startsWith("Done.")).toBe(true);
  });

  it("🔴 the critic saw 3,863 tokens, answered in 24, and approved", () => {
    const critic = loadWave4Failure().generations.find((g) => g.job === "merge-critic");
    expect(critic?.input_tokens).toBe(3863);
    expect(critic?.output_tokens).toBe(24);
    expect(critic?.outcome).toBe("success");
  });

  it("🔴 wrote no topic_revisions row, so loss checks iterate an empty set", () => {
    expect(loadWave4Failure().topicRevisions).toEqual([]);
  });

  // ── D13: the embed-topic-summary failure belongs to a different run ────────

  it("embed-topic-summary SUCCEEDED on this run — the 0/0/NULL row is not this document", () => {
    const embed = loadWave4Failure().generations.find((g) => g.job === "embed-topic-summary");
    expect(embed?.outcome).toBe("success");
    expect(embed?.input_tokens).toBe(130);
    expect(embed?.latency_ms).toBe(120);
    expect(embed?.cost_usd).not.toBeNull();
  });

  it("every citation names this document", () => {
    const f = loadWave4Failure();
    const ids = [
      ...f.topicPage.notes.flatMap((n) => n.sources),
      ...f.topicPage.formulas.flatMap((x) => x.sources),
      ...f.topicPage.keyTerms.flatMap((k) => k.sources),
    ].map((s) => s.documentId);
    expect(new Set(ids)).toEqual(new Set([WAVE4_DOCUMENT_ID]));
  });
});
