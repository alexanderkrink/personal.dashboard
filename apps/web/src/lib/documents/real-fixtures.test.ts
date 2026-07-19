/**
 * Tier 2 — the validators against the **real, gitignored** course corpus.
 *
 * `packages/core`'s own suite builds its archives and PDFs byte by byte, which
 * is what makes the malformed cases expressible at all. What it cannot do is
 * prove the validators survive files produced by PowerPoint, Acrobat and a
 * publisher's DRM pipeline — real files carry leading junk, ZIP64 escapes,
 * 1,400-entry media directories and comment blocks that no synthetic fixture
 * thinks to include. Those only hold against the actual bytes, so they are
 * asserted here.
 *
 * This file lives in `apps/web` rather than in `packages/core` for a boundary
 * reason, not a convenience one: reading a binary fixture needs `node:fs`, and
 * `packages/core` deliberately has no `@types/node` (see its `vite-env.d.ts`).
 * `apps/web` has both, so the real-bytes tier lands here and core stays pure.
 *
 * ## The skip path
 *
 * CI has no fixtures, so every case must skip cleanly rather than fail.
 * `.local-fixtures/` is gitignored and stays that way — the corpus is
 * copyrighted course material and a 164 MB textbook.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MAX_DOCUMENT_BYTES, validateDocument, validateDocumentSize } from "@study/core";
import { describe, expect, it } from "vitest";

const FIXTURES = join(process.cwd(), ".local-fixtures");

function fixture(...segments: string[]): { path: string; size: number } | null {
  try {
    const path = join(FIXTURES, ...segments);
    return { path, size: statSync(path).size };
  } catch {
    return null;
  }
}

const KOTLER = fixture("book", "kotler-principles-of-marketing.pdf");
const DECK_PDF = fixture("decks", "marketing", "s01-basics.pdf");
const DECK_PPTX = fixture("decks", "marketing", "s01-basics.pptx");
const BIG_PPTX = fixture("decks", "marketing", "s19-differentiation-chp7.pptx");
const SYLLABUS_PDF = fixture("syllabi", "marketing-fundamentals-sem1.pdf");
const SYLLABUS_DOCX = fixture("syllabi", "bdba-loes-fall2025.docx");

describe("the real over-cap textbook is rejected by size alone", () => {
  it.skipIf(KOTLER === null)("names the actual size, the limit and the fix", () => {
    if (KOTLER === null) return;

    // The size check runs on `File.size` — no read, no hash, no upload. That is
    // the whole point: 164 MB never moves.
    expect(KOTLER.size).toBe(163_918_977);
    expect(KOTLER.size).toBeGreaterThan(MAX_DOCUMENT_BYTES);

    const verdict = validateDocumentSize({
      sizeBytes: KOTLER.size,
      filename: "kotler-principles-of-marketing.pdf",
    });

    expect(verdict?.ok).toBe(false);
    if (verdict?.ok !== false) return;

    expect(verdict.rejection.code).toBe("too-large");
    expect(verdict.rejection.message).toBe(
      "“kotler-principles-of-marketing.pdf” is 156 MB. The limit is 50 MB. " +
        "Compress it, or split it into parts under 50 MB, and upload again.",
    );
  });
});

describe("real PDFs pass the magic-byte sniff", () => {
  it.skipIf(DECK_PDF === null)("accepts a real lecture deck exported to PDF", () => {
    if (DECK_PDF === null) return;
    const verdict = validateDocument({
      bytes: new Uint8Array(readFileSync(DECK_PDF.path)),
      filename: "s01-basics.pdf",
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.document.format).toBe("pdf");
      expect(verdict.document.sizeBytes).toBe(DECK_PDF.size);
    }
  });

  it.skipIf(SYLLABUS_PDF === null)("accepts a real syllabus PDF", () => {
    if (SYLLABUS_PDF === null) return;
    const verdict = validateDocument({
      bytes: new Uint8Array(readFileSync(SYLLABUS_PDF.path)),
      filename: "marketing-fundamentals-sem1.pdf",
    });
    expect(verdict.ok).toBe(true);
  });

  /**
   * The false-positive risk in `looksEncrypted` is the one worth measuring
   * against real files rather than reasoning about: publisher PDFs are exactly
   * the documents most likely to contain the byte sequence `/Encrypt` somewhere
   * innocent. None of the corpus is password-protected, so every one of them
   * must come back clean.
   */
  it.skipIf(KOTLER === null)("does not call an unprotected publisher PDF encrypted", () => {
    if (KOTLER === null) return;
    // Reading 164 MB is fine here; the point is precisely to scan the whole
    // thing for a false positive.
    const verdict = validateDocument({
      bytes: new Uint8Array(readFileSync(KOTLER.path)),
      filename: "kotler.pdf",
    });
    expect(verdict.ok).toBe(false);
    // Rejected for SIZE, not for encryption — which is what proves the scan
    // stayed quiet on 164 MB of real publisher output.
    if (!verdict.ok) expect(verdict.rejection.code).toBe("too-large");
  });
});

describe("real PPTX archives read through the central directory", () => {
  it.skipIf(DECK_PPTX === null)("accepts a real 9 MB PowerPoint deck", () => {
    if (DECK_PPTX === null) return;
    const verdict = validateDocument({
      bytes: new Uint8Array(readFileSync(DECK_PPTX.path)),
      filename: "s01-basics.pptx",
    });

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.document.format).toBe("pptx");
    // The archive really was walked — a real deck has many parts, and its
    // contents really do inflate beyond the packed size.
    expect(verdict.document.archive?.entryCount ?? 0).toBeGreaterThan(10);
    expect(verdict.document.archive?.declaredInflatedBytes ?? 0).toBeGreaterThan(0);
  });

  /**
   * 47 MB packed — the largest deck in the corpus that is still under the file
   * cap, and the one most likely to trip the inflated-size guard by accident. If
   * the 200 MB threshold were mis-set, a legitimate deck would be refused, and
   * that is a far worse failure than letting a bomb through slowly.
   */
  it.skipIf(BIG_PPTX === null)("does not mistake the largest real deck for a bomb", () => {
    if (BIG_PPTX === null) return;
    expect(BIG_PPTX.size).toBeLessThan(MAX_DOCUMENT_BYTES);

    const verdict = validateDocument({
      bytes: new Uint8Array(readFileSync(BIG_PPTX.path)),
      filename: "s19-differentiation-chp7.pptx",
    });
    expect(verdict.ok).toBe(true);
  });

  it.skipIf(SYLLABUS_DOCX === null)("recognises a real .docx and says to export as PDF", () => {
    if (SYLLABUS_DOCX === null) return;
    const verdict = validateDocument({
      bytes: new Uint8Array(readFileSync(SYLLABUS_DOCX.path)),
      filename: "bdba-loes-fall2025.docx",
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.rejection.code).toBe("unsupported-format");
    expect(verdict.rejection.message).toMatch(/Word document/);
    expect(verdict.rejection.message).toMatch(/export as PDF/i);
  });
});
