import { describe, expect, it } from "vitest";
import { safeStorageFilename, storagePathFor } from "./paths";

/**
 * The storage path is checked by SQL, in a constraint this test file mirrors:
 *
 * ```sql
 * constraint documents_storage_path_convention check (
 *   storage_path like (user_id::text || '/' || course_id::text || '/' || id::text || '/%')
 * )
 * ```
 *
 * Gate 1 confirmed that pattern is exact — no wildcards beyond the trailing
 * `/%`. So a path that disagrees with it does not degrade gracefully: the INSERT
 * is rejected *after the bytes have already been uploaded*, which is the F5
 * orphan scenario. That makes "the client and the server build the same string"
 * a correctness property worth pinning rather than a tidiness one.
 */

const USER = "63966c02-e3e7-439a-936c-36988ead84e6";
const COURSE = "620b97d4-8dec-4961-ba44-a4bd4675b955";
const DOCUMENT = "a223e9ac-7bdd-4d60-97d1-41a08872cc1a";

/** The check constraint's `LIKE` pattern, as a predicate. */
function satisfiesPathConvention(path: string): boolean {
  return (
    path.startsWith(`${USER}/${COURSE}/${DOCUMENT}/`) &&
    path.length > `${USER}/${COURSE}/${DOCUMENT}/`.length
  );
}

describe("storagePathFor", () => {
  it("builds the four-segment path the check constraint requires", () => {
    const path = storagePathFor({
      userId: USER,
      courseId: COURSE,
      documentId: DOCUMENT,
      filename: "s01-basics.pdf",
    });

    expect(path).toBe(`${USER}/${COURSE}/${DOCUMENT}/s01-basics.pdf`);
    expect(satisfiesPathConvention(path)).toBe(true);
  });

  it.each([
    // The real corpus. Spaces, parentheses and hyphens must all survive — this
    // is the filename the user reads back on the status card.
    "Micro - Unit 3- Elasticities (2026).pptx",
    "s19-differentiation-chp7.pptx",
    "bdba-loes-fall2025.docx",
    "kotler-principles-of-marketing.pdf",
  ])("keeps the real filename %s intact and still satisfies the constraint", (filename) => {
    const path = storagePathFor({
      userId: USER,
      courseId: COURSE,
      documentId: DOCUMENT,
      filename,
    });
    expect(path.endsWith(filename)).toBe(true);
    expect(satisfiesPathConvention(path)).toBe(true);
  });

  it.each([
    // Slashes become hyphens first, THEN the leading dots are stripped — so
    // `../../etc/passwd` collapses to a single harmless segment.
    ["../../etc/passwd", "-..-etc-passwd"],
    ["a/b/c.pdf", "a-b-c.pdf"],
    ["back\\slash.pdf", "back-slash.pdf"],
    ["100%-final.pdf", "100--final.pdf"],
    [".hidden.pdf", "hidden.pdf"],
  ])("neutralises %s so it cannot add a path segment", (input, expected) => {
    expect(safeStorageFilename(input)).toBe(expected);

    const path = storagePathFor({
      userId: USER,
      courseId: COURSE,
      documentId: DOCUMENT,
      filename: input,
    });
    // The decisive property: still exactly four segments, so the constraint's
    // `{id}/%` tail cannot be satisfied by a path that actually nests deeper.
    expect(path.split("/")).toHaveLength(4);
    expect(satisfiesPathConvention(path)).toBe(true);
  });

  it("strips control characters without leaving an empty segment", () => {
    // Built from char codes rather than written literally — a source file with
    // real control bytes in it is its own problem.
    const nasty = `deck${String.fromCharCode(0)}${String.fromCharCode(9)}${String.fromCharCode(127)}.pdf`;
    expect(safeStorageFilename(nasty)).toBe("deck.pdf");
  });

  it("never yields an empty filename", () => {
    expect(safeStorageFilename("")).toBe("upload");
    expect(safeStorageFilename("...")).toBe("upload");
    expect(safeStorageFilename("///")).toBe("---");
  });

  it("bounds the length so the whole key stays short", () => {
    const long = `${"a".repeat(500)}.pdf`;
    expect(safeStorageFilename(long)).toHaveLength(200);
  });

  it("is idempotent — the client sanitises, then the server sanitises again", () => {
    // `uploadToStorage` names the object from the raw `file.name`, and
    // `registerUpload` rebuilds the same path from the raw filename it was
    // handed. If sanitising twice differed from sanitising once, the row would
    // point at a path the bytes are not at.
    for (const filename of ["Micro - Unit 3- Elasticities (2026).pptx", "a/b%c.pdf", ".x.pdf"]) {
      const once = safeStorageFilename(filename);
      expect(safeStorageFilename(once)).toBe(once);
    }
  });

  /**
   * `registerUpload` reconciles `size_bytes` against `metadata.size` from a
   * `storage.list()` of the document's prefix, and has to pick its entry out of
   * that listing by name. The name Storage holds is the LAST SEGMENT OF THE
   * PATH — the sanitised one — never the raw filename the browser sent.
   *
   * Matching the raw name instead is silent: `find` returns `undefined`, the
   * reconciliation falls back to the client's self-reported size, and the 50 MB
   * re-check goes back to measuring the client against its own claim. Nothing
   * throws and nothing logs, so this pins the invariant the action depends on.
   */
  it("names the stored object by the path's last segment, which is not always the raw filename", () => {
    const parts = {
      userId: "11111111-1111-4111-8111-111111111111",
      courseId: "22222222-2222-4222-8222-222222222222",
      documentId: "33333333-3333-4333-8333-333333333333",
    };

    // Realistic names whose sanitised form differs from what the browser sent.
    for (const filename of [
      "Unit 4 — 50% margin.pptx",
      "notes/chapter 3.pdf",
      ".hidden deck.pptx",
      `${"a".repeat(500)}.pdf`,
    ]) {
      const path = storagePathFor({ ...parts, filename });
      const lastSegment = path.slice(path.lastIndexOf("/") + 1);

      expect(lastSegment).toBe(safeStorageFilename(filename));
      // The point of the test: the raw name would NOT have matched the listing.
      expect(lastSegment).not.toBe(filename);
    }

    // …and for an ordinary name the two coincide, which is why matching on the
    // raw filename passed every manual check it was ever given.
    const ordinary = "Micro - Unit 3- Elasticities (2026).pptx";
    const ordinaryPath = storagePathFor({ ...parts, filename: ordinary });
    expect(ordinaryPath.slice(ordinaryPath.lastIndexOf("/") + 1)).toBe(ordinary);
  });
});
