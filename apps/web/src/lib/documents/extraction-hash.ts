/**
 * The index-INDEPENDENT identity of "this document, extracted this way".
 *
 * The Wave 7 §3 fix keys a document's frozen merge plan on a hash of its extraction rather
 * than on the routing call's `input_hash`. The routing hash is index-DEPENDENT — the two
 * `topic-routing` rows for the failing document (.local-fixtures/wave7-section3) share
 * `prompt_version = 5` but carry different `input_hash` values because the topic index
 * changed between passes. Keying on it would mint a fresh plan key on every retry, which is
 * the opposite of a frozen receipt. `documents.extraction` does not change between passes, so
 * a canonical hash of it is the stable identity the plan needs.
 *
 * Computed in the application (never in SQL), per the migration's design note.
 */

import { sha256Hex } from "@study/ai";

/**
 * Deterministic JSON: every object's keys are emitted in sorted order, recursively, so two
 * structurally-equal values serialize to the same string regardless of key insertion order.
 * Array order is preserved (arrays are ordered data). `undefined` object values are dropped,
 * matching `JSON.stringify` and the jsonb this hashes over, which cannot hold `undefined`.
 */
export function canonicalize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry === undefined ? null : entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const body = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",");
  return `{${body}}`;
}

/**
 * sha256 over the canonical serialization of `documents.extraction` (the whole jsonb column —
 * envelope and payload, since `sourceUnits` and the fidelity route both feed segmentation).
 */
export function extractionHash(extraction: unknown): Promise<string> {
  return sha256Hex(canonicalize(extraction));
}
