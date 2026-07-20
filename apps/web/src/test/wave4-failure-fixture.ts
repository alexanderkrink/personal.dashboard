/**
 * Loader for the Wave 4 failure corpus — the real production artifact produced by
 * `Sampling Distributions.pdf` on 2026-07-20, captured before Wave 5 touched anything.
 *
 * The corpus itself lives in `apps/web/.local-fixtures/wave4-failure/`, which is
 * **gitignored**: it is real user data from `krinkk02@gmail.com` and does not belong in the
 * repository. That means it is present on Alexander's machine and absent in CI, so every
 * consumer must tolerate its absence rather than assume it. {@link describeWithWave4Failure}
 * is the intended entry point — it skips the suite when the corpus is missing instead of
 * failing a CI run that was never going to have the data.
 *
 * See the corpus README for what the artifact proves. In short: the extraction is good, the
 * six formulas ARE supported by the source, and the defect is that all 20 citations on the
 * produced page collapse onto page 2 (the "Topic Goals" slide) while 47 read pages went
 * uncited — with `trustworthy: true` and zero warnings.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe } from "vitest";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".local-fixtures",
  "wave4-failure",
);

/** The document this corpus was captured from. */
export const WAVE4_DOCUMENT_ID = "2b33fe5b-0c05-4c15-9f56-d98cd3f00c31";
/** The single topic the run produced. */
export const WAVE4_TOPIC_ID = "414cc674-6de7-44d7-ae0f-3ccf59b0fed4";
/** The slide every citation collapsed onto — the "Topic Goals" objectives list. */
export const WAVE4_COLLAPSED_PAGE = 2;

/** A `{page, documentId}` citation as it appears on a topic page. */
export interface FixtureSource {
  readonly page: number;
  readonly documentId: string;
}

interface FixtureNote {
  readonly id: string;
  readonly heading: string;
  readonly markdown: string;
  readonly sources: readonly FixtureSource[];
}

interface FixtureFormula {
  readonly name: string;
  readonly latex: string;
  readonly explanation: string;
  readonly sources: readonly FixtureSource[];
}

interface FixtureKeyTerm {
  readonly term: string;
  readonly definition: string;
  readonly sources: readonly FixtureSource[];
}

export interface FixtureTopicPage {
  readonly summary: string;
  readonly notes: readonly FixtureNote[];
  readonly formulas: readonly FixtureFormula[];
  readonly keyTerms: readonly FixtureKeyTerm[];
  readonly openQuestions: readonly unknown[];
  readonly workedExamples: readonly unknown[];
}

export interface FixtureCoverage {
  readonly checked: boolean;
  readonly trustworthy: boolean;
  readonly warnings: readonly unknown[];
  readonly pagesTotal: number;
  readonly pagesMapped: number;
  readonly pagesUnmapped: number;
  readonly pagesSkipped: number;
  readonly pagesUndeclared: number;
  readonly topicCount: number;
  readonly gaps: readonly { kind: string; reason: string; fromPage: number; toPage: number }[];
  readonly missingObjectives: readonly unknown[];
}

export interface FixtureExtractionPage {
  readonly page: number;
  readonly title: string;
  readonly markdown: string;
}

export interface FixtureExtraction {
  readonly pages: readonly FixtureExtractionPage[];
  readonly formulas: readonly { page: number; latex: string; meaning: string }[];
  readonly definitions: readonly { page: number; term: string; definition: string }[];
  readonly headings: readonly { page: number; text: string; level: number }[];
  readonly summary: string;
  readonly skipped: readonly { reason: string; fromPage: number; toPage: number }[];
  readonly workedExamples: readonly { page: number; title: string; summary: string }[];
}

export interface FixtureEvent {
  readonly step: string;
  readonly level: "info" | "warn" | "error";
  readonly detail: string;
  readonly created_at: string;
}

export interface FixtureGeneration {
  readonly job: string;
  readonly prompt_id: string;
  readonly provider: string;
  readonly model: string;
  readonly outcome: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cost_usd: string | null;
  readonly latency_ms: number;
  readonly error_message: string | null;
  readonly created_at: string;
}

export interface FixtureChunk {
  readonly id: string;
  readonly source: string;
  readonly content: string;
  readonly token_count: number;
  readonly locator: { page: number; toPage?: number };
}

/**
 * The `documents` row itself, for consumers that render a document rather than only its
 * coverage — the topic page names the file, its session label and its extraction fidelity.
 */
export interface FixtureDocumentRow {
  readonly id: string;
  readonly filename: string;
  readonly session_label: string | null;
  readonly kind: string;
  readonly status: string;
  readonly extraction_fidelity: string | null;
  readonly failure_reason: string | null;
  readonly failed_topics: readonly unknown[];
  readonly created_at: string;
}

/** The `topics` row, for consumers that build a whole topic view from the corpus. */
export interface FixtureTopicRow {
  readonly id: string;
  readonly course_id: string;
  readonly title: string;
  readonly slug: string;
  readonly summary: string;
  readonly page: FixtureTopicPage;
  readonly exam_weight: number;
  readonly exam_weight_override: number | null;
  readonly revision: number;
  readonly updated_at: string;
}

export interface Wave4Failure {
  /** `documents.coverage` — `trustworthy: true` with 47 unmapped pages. */
  readonly coverage: FixtureCoverage;
  /** The whole `documents` row: `Sampling Distributions.pdf`, "Chapter 6", `visual`. */
  readonly document: FixtureDocumentRow;
  /** The whole `topics` row: "Sampling Distributions", `revision: 1`, no override. */
  readonly topic: FixtureTopicRow;
  /** The real extraction, already unwrapped from `documents.extraction -> 'extraction'`. */
  readonly extraction: FixtureExtraction;
  /** The sibling keys alongside `extraction`: `route`, `fidelity`, `sourceUnits`, `wordsPerSlide`. */
  readonly extractionEnvelope: Record<string, unknown>;
  /** The produced 12,510-char topic page, every citation pointing at page 2. */
  readonly topicPage: FixtureTopicPage;
  /** All 12 processing events — every one `level: "info"`. */
  readonly events: readonly FixtureEvent[];
  /** The run's 8 metering rows. */
  readonly generations: readonly FixtureGeneration[];
  /** 26 document chunks, correctly spanning pages 2–53. */
  readonly chunks: readonly FixtureChunk[];
  /** `topic_sources` rows — one row, `locators: [{page: 2}]`. */
  readonly topicSources: readonly { locators: readonly { page: number }[] }[];
  /** `topic_revisions` rows — **empty**, despite `topics.revision = 1`. */
  readonly topicRevisions: readonly unknown[];
}

/** True when the corpus is present on this machine. False in CI. */
export function hasWave4Failure(): boolean {
  return existsSync(join(FIXTURE_DIR, "topic.json"));
}

/**
 * A frozen prompt preimage — the exact rendered string a model was sent on the failing run.
 *
 * These files are the Wave 4 evidence in its most durable form. `input_hash` is
 * `sha256(`${id}@${version}\n${rendered}`)`, so a stored hash is only a receipt for as long
 * as the preimage that produced it survives. Reconstructing the preimage from *today's*
 * templates worked in Wave 5 and will stop working the moment any prompt is edited — at
 * which point the obvious repair is to update the expected hash, which would silently
 * destroy the evidence rather than preserve it.
 *
 * So the rendered strings are frozen on disk beside the rest of the corpus, and the receipt
 * is asserted against them rather than against the live templates.
 *
 * ⚠ **Never regenerate these files to make a test pass.** A live template that no longer
 * reproduces one of them means the template moved on, which is fine and expected — record a
 * NEW receipt under the new version. Editing an old one falsifies history.
 */
export function loadPreimage(name: "topic-routing-v1" | "topic-merge-v1"): string {
  return readFileSync(join(FIXTURE_DIR, `preimage-${name}.txt`), "utf8");
}

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as T;
}

function first<T>(rows: readonly T[], name: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`wave4-failure fixture: ${name} is empty`);
  return row;
}

/**
 * Loads the corpus. Throws when it is absent — call {@link hasWave4Failure} first, or use
 * {@link describeWithWave4Failure}, which handles that for you.
 */
export function loadWave4Failure(): Wave4Failure {
  if (!hasWave4Failure()) {
    throw new Error(
      `wave4-failure fixture not found at ${FIXTURE_DIR}. It is gitignored real user data; ` +
        `re-capture it from production or guard the suite with describeWithWave4Failure().`,
    );
  }

  const document = first(
    readJson<(FixtureDocumentRow & { coverage: FixtureCoverage })[]>("document.json"),
    "document.json",
  );
  const extractionRow = first(
    readJson<{ extraction: Record<string, unknown> }[]>("extraction.json"),
    "extraction.json",
  );
  const topic = first(readJson<FixtureTopicRow[]>("topic.json"), "topic.json");

  const { extraction, ...extractionEnvelope } = extractionRow.extraction;

  return {
    coverage: document.coverage,
    document,
    topic,
    extraction: extraction as FixtureExtraction,
    extractionEnvelope,
    topicPage: topic.page,
    events: readJson<FixtureEvent[]>("processing-events.json"),
    generations: readJson<FixtureGeneration[]>("ai-generations.json"),
    chunks: readJson<FixtureChunk[]>("document-chunks.json"),
    topicSources: readJson<{ locators: { page: number }[] }[]>("topic-sources.json"),
    topicRevisions: readJson<unknown[]>("topic-revisions.json"),
  };
}

/**
 * Every `{page, documentId}` citation on the topic page, across notes, formulas and key
 * terms. On the recorded failure this is 20 entries and every one of them is page 2 — the
 * single assertion that most directly captures the bug.
 */
export function citedPages(page: FixtureTopicPage): readonly number[] {
  return [
    ...page.notes.flatMap((n) => n.sources),
    ...page.formulas.flatMap((f) => f.sources),
    ...page.keyTerms.flatMap((k) => k.sources),
  ].map((s) => s.page);
}

/** Pages the extraction actually read — 48 of them, spanning 2–53. */
export function extractedPages(extraction: FixtureExtraction): readonly number[] {
  return extraction.pages.map((p) => p.page);
}

/**
 * `describe` that skips instead of failing when the corpus is absent. Use this for any suite
 * that asserts against the recorded failure, so CI stays green without the data.
 */
export const describeWithWave4Failure: typeof describe.skip = hasWave4Failure()
  ? describe
  : describe.skip;
