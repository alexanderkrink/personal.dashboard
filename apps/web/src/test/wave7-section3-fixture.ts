/**
 * Loader for the Wave 7 §3 corpus — the real production artifact whose two-pass processing
 * demonstrates the *non-idempotent retry → silent data loss* failure. Captured during Wave 7
 * setup from `Sampling Distributions.pdf` (54 pages), before the fix and before any re-upload
 * could disturb the rows.
 *
 * The sequence, reconstructed from `processing-events.json` (see the corpus README): pass 1
 * routed 48 segments on an EMPTY index into 8 create targets, created 4 of them, then the
 * merge step died silently inside target 5 (`merge:topic:new:seg-15`, "Creating 'Standard
 * Error of the Mean'") at 10:34:38 — no completion event. Inngest retried; pass 2's `route`
 * re-read the extraction and RE-ROUTED all 48 segments into the 4 topics pass 1 had committed,
 * `planMergeWork` skipped all 4, and the document finalized `ready` with the 4 never-created
 * topics and ~24 pages permanently lost. The only honest signal left was
 * `coverage.trustworthy = false`.
 *
 * The two `topic-routing` rows in `ai-generations.json` share `prompt_version = 5` but carry
 * DIFFERENT `input_hash` values ({@link WAVE7_ROUTING_HASH_PASS1} vs
 * {@link WAVE7_ROUTING_HASH_PASS2}) because the index changed between passes — the proof that
 * the frozen plan must be keyed on a hash of the extraction, not the routing input_hash.
 *
 * The corpus lives in `apps/web/.local-fixtures/wave7-section3/`, which is **gitignored** (real
 * user data). Present on Alexander's machine, absent in CI — every consumer must tolerate its
 * absence via {@link describeWithWave7Section3} or {@link hasWave7Section3}.
 *
 * **Frozen-fixture rule:** the files are byte-frozen. Tests assert against them; never edit
 * them to make a test pass.
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
  "wave7-section3",
);

/** The document this corpus was captured from (`Sampling Distributions.pdf`, 54 pages). */
export const WAVE7_DOCUMENT_ID = "7d7b2f96-8dbf-456c-87c6-843d236673ce";
/** The course, derived from the document row rather than assumed. */
export const WAVE7_COURSE_ID = "381c4350-b585-4ec3-b645-5543aa65a5aa";
/** The tenant. */
export const WAVE7_USER_ID = "0092dd81-4436-452f-9517-235cc8ea4cf2";

/** Pass 1's `topic-routing` `input_hash` — routed on an EMPTY index. */
export const WAVE7_ROUTING_HASH_PASS1 =
  "0ad4c8d9f3db4a067e1914dd7d579df8f8154cf1e443595a5f4e056a267d7d2e";
/** Pass 2's `topic-routing` `input_hash` — routed on the 4-topic index pass 1 left behind.
 *  Same `prompt_version` (5), DIFFERENT hash: the index changed, so the routing input did. */
export const WAVE7_ROUTING_HASH_PASS2 =
  "84b35a2731ed72924b963ccfdf9d2fd27f8ea7465122056e4d789bdc2503684d";

/** The stable key of the target the worker died inside — the 5th of 8, never created. */
export const WAVE7_KILL_TARGET_KEY = "new:seg-15";

export interface Wave7Generation {
  readonly id: string;
  readonly job: string;
  readonly prompt_id: string;
  readonly prompt_version: number;
  readonly provider: string;
  readonly model: string;
  readonly input_hash: string;
  readonly created_at: string;
}

export interface Wave7TopicRow {
  readonly id: string;
  readonly course_id: string;
  readonly title: string;
  readonly slug: string;
  readonly summary: string;
  readonly page: unknown;
  readonly revision: number;
}

export interface Wave7TopicSourceRow {
  readonly topic_id: string;
  readonly document_id: string;
  readonly locators: readonly { page: number }[];
  readonly merged_at_revision: number;
}

export interface Wave7RevisionRow {
  readonly topic_id: string;
  readonly revision: number;
  readonly source: string;
  readonly needs_review: boolean;
  readonly review_notes: readonly string[];
  readonly change_summary: string;
  readonly document_id: string | null;
}

export interface Wave7Section3 {
  /** `documents.coverage` — `trustworthy: false`, `topicCount: 4`. */
  readonly coverage: FixtureCoverage;
  /** The real extraction, unwrapped from `documents.extraction -> 'extraction'`. */
  readonly extraction: FixtureExtraction;
  /** The whole `documents.extraction` column (envelope + payload) — what the plan hashes. */
  readonly extractionColumn: Record<string, unknown>;
  /** The 4 topics pass 1 committed before the kill. */
  readonly topics: readonly Wave7TopicRow[];
  /** The 4 provenance rows — all `merged_at_revision: 1` (fresh creates). */
  readonly topicSources: readonly Wave7TopicSourceRow[];
  /** The 4 revision-0 'merge' snapshots; two flagged `needs_review` by the critic. */
  readonly topicRevisions: readonly Wave7RevisionRow[];
  /** All 24 metering rows; the TWO `topic-routing` rows carry different input_hash. */
  readonly generations: readonly Wave7Generation[];
  /** All 70 processing events, both passes. */
  readonly events: readonly FixtureEvent[];
}

/** True when the corpus is present on this machine. False in CI. */
export function hasWave7Section3(): boolean {
  return existsSync(join(FIXTURE_DIR, "topics.json"));
}

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as T;
}

function first<T>(rows: readonly T[], name: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`wave7-section3 fixture: ${name} is empty`);
  return row;
}

export function loadWave7Section3(): Wave7Section3 {
  if (!hasWave7Section3()) {
    throw new Error(
      `wave7-section3 fixture not found at ${FIXTURE_DIR}. It is gitignored real user data; ` +
        `re-capture it from production or guard the suite with describeWithWave7Section3().`,
    );
  }

  const document = first(
    readJson<(Record<string, unknown> & { coverage: FixtureCoverage })[]>("document.json"),
    "document.json",
  );
  const extractionColumn = document.extraction as Record<string, unknown>;
  const extraction = extractionColumn.extraction as FixtureExtraction;

  return {
    coverage: document.coverage,
    extraction,
    extractionColumn,
    topics: readJson<Wave7TopicRow[]>("topics.json"),
    topicSources: readJson<Wave7TopicSourceRow[]>("topic-sources.json"),
    topicRevisions: readJson<Wave7RevisionRow[]>("topic-revisions.json"),
    generations: readJson<Wave7Generation[]>("ai-generations.json"),
    events: readJson<FixtureEvent[]>("processing-events.json"),
  };
}

/** `describe` that skips instead of failing when the corpus is absent. */
export const describeWithWave7Section3: typeof describe.skip = hasWave7Section3()
  ? describe
  : describe.skip;
