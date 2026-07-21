/**
 * Loader for the Wave 6 over-merge corpus — the real production artifact produced by
 * `Sampling Distributions.pdf` re-uploaded on 2026-07-21, captured before the Wave 6 fix
 * landed and before any re-upload could disturb the rows.
 *
 * This is the run that proved the *other* half of the Wave 4 problem. Grounding was
 * perfect — 47/47 segments routed, 47 pages mapped, 70/70 citations resolve, coverage
 * `trustworthy: true` — and the document still produced `topicCount: 1` where the
 * acceptance band requires 4–12. The router saw 47 segments with 29 distinct headings and
 * an EMPTY topic index, and returned one create (the deck's own title) plus 46 title-assigns
 * into it. Proven byte-exact by `input_hash` preimage reconstruction; the reconstructed
 * preimage is frozen beside the rows.
 *
 * The corpus lives in `apps/web/.local-fixtures/wave6-overmerge/`, which is **gitignored**
 * (real user data). Present on Alexander's machine, absent in CI — every consumer must
 * tolerate its absence via {@link describeWithWave6Overmerge} or {@link hasWave6Overmerge}.
 *
 * **Frozen-fixture rule:** the files are byte-frozen once written. Tests assert against
 * them; never edit them to make a test pass.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe } from "vitest";
import type { FixtureCoverage, FixtureEvent, FixtureExtraction } from "./wave4-failure-fixture";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".local-fixtures",
  "wave6-overmerge",
);

/** The document this corpus was captured from. */
export const WAVE6_DOCUMENT_ID = "d90be554-ae78-4d1d-885d-0a5370f59d36";
/** The single topic the run produced. */
export const WAVE6_TOPIC_ID = "def90c43-8e6e-4a92-8d04-e3ffff7bf1d3";
/** The recorded `topic-routing` `input_hash` — the receipt for the v1 preimage. */
export const WAVE6_RECORDED_ROUTING_HASH =
  "26360e67e5678dde2f4a55fe28c574cb1a887f3e2af728cc8c28758f442f3c51";

/** The routing-call variables of the run, read off the reconstructed preimage. */
export const WAVE6_COURSE_TITLE = "PROBABILITY & STATISTICS FOR DATA MANAGEMENT AND ANALYSIS";
export const WAVE6_DOCUMENT_LABEL = "Sampling Distributions.pdf";
/** `documents.session_label` is null on this upload (unlike Wave 4's "Chapter 6"). */
export const WAVE6_SESSION_LABEL: string | null = null;

export interface Wave6Generation {
  readonly id: string;
  readonly job: string;
  readonly prompt_id: string;
  readonly prompt_version: number;
  readonly provider: string;
  readonly model: string;
  readonly outcome: string;
  readonly input_hash: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cost_usd: number | string | null;
  readonly created_at: string;
}

export interface Wave6RevisionRow {
  readonly topic_id: string;
  readonly revision: number;
  readonly source: string;
  readonly needs_review: boolean;
  readonly review_notes: readonly string[];
  readonly change_summary: string;
}

export interface Wave6Overmerge {
  /** `documents.coverage` — `topicCount: 1`, `trustworthy: true`, `warnings: []`. */
  readonly coverage: FixtureCoverage;
  /** The real extraction, unwrapped from `documents.extraction -> 'extraction'`. */
  readonly extraction: FixtureExtraction;
  /** The sibling keys alongside `extraction`: `route`, `fidelity`, `sourceUnits`, …. */
  readonly extractionEnvelope: Record<string, unknown>;
  /** All 61 processing events, incl. the `Routing decisions (47)` digest. */
  readonly events: readonly FixtureEvent[];
  /** The run's 10 metering stamp rows. `topic-routing` is v1. */
  readonly generations: readonly Wave6Generation[];
  /** The one revision row — `needs_review: false`, `review_notes: []`. */
  readonly revisions: readonly Wave6RevisionRow[];
}

/** True when the corpus is present on this machine. False in CI. */
export function hasWave6Overmerge(): boolean {
  return existsSync(join(FIXTURE_DIR, "extraction.json"));
}

/**
 * The frozen `topic-routing` v1 preimage, exactly as hashed: the file already carries the
 * `topic-routing@1\n` prefix, so `sha256(file bytes)` IS the recorded `input_hash`.
 *
 * ⚠ Never regenerate this file to make a test pass — see `loadPreimage` in
 * `wave4-failure-fixture.ts` for the full rule.
 */
export function loadWave6Preimage(): string {
  return readFileSync(join(FIXTURE_DIR, "preimage-topic-routing-v1.txt"), "utf8");
}

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as T;
}

export function loadWave6Overmerge(): Wave6Overmerge {
  if (!hasWave6Overmerge()) {
    throw new Error(
      `wave6-overmerge fixture not found at ${FIXTURE_DIR}. It is gitignored real user data; ` +
        `re-capture it from production or guard the suite with describeWithWave6Overmerge().`,
    );
  }

  const document = readJson<{ coverage: FixtureCoverage }>("document.json");
  // Unlike the wave4 corpus, `document.json` is the single row (not a one-row array) and
  // `extraction.json` is the bare `documents.extraction` envelope — the capture script split
  // the column out of the row. The payload is still nested at `extraction`.
  const { extraction, ...extractionEnvelope } =
    readJson<Record<string, unknown>>("extraction.json");

  return {
    coverage: document.coverage,
    extraction: extraction as FixtureExtraction,
    extractionEnvelope,
    events: readJson<FixtureEvent[]>("processing-events.json"),
    generations: readJson<Wave6Generation[]>("ai-generations.json"),
    revisions: readJson<Wave6RevisionRow[]>("topic-revisions.json"),
  };
}

/** `describe` that skips instead of failing when the corpus is absent. */
export const describeWithWave6Overmerge: typeof describe.skip = hasWave6Overmerge()
  ? describe
  : describe.skip;
