/**
 * The two things `validate` needs to know about a PDF without parsing one.
 *
 *   1. Is it actually a PDF? (`%PDF-`, by bytes, never by extension.)
 *   2. Is it encrypted? — because an encrypted PDF is the single most common
 *      poison file in a real course corpus. Publishers ship password-protected
 *      readings routinely, and PLAN §7 names it explicitly: the user must be
 *      told "This PDF is password-protected", not handed a downstream extraction
 *      error from Gemini forty seconds and one billed call later.
 */

import { asciiBytes, indexOfBytes, isAsciiDigit, isPdfWhitespace, matchesAt } from "./bytes";

const PDF_HEADER = asciiBytes("%PDF-");
const ENCRYPT_KEY = asciiBytes("/Encrypt");

/**
 * ISO 32000-1 §7.5.2 requires `%PDF-` at byte 0, but the same standard's
 * implementation notes acknowledge readers that tolerate leading junk, and real
 * files do carry it (an HTTP preamble, a mail artefact, a BOM). Acrobat scans
 * the first 1024 bytes, so we do too: rejecting a file every real reader opens
 * would be a validator that is wrong in the annoying direction.
 */
const HEADER_SEARCH_WINDOW = 1024;

/** True when `%PDF-` appears within the first KB. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return indexOfBytes(bytes, PDF_HEADER, 0, HEADER_SEARCH_WINDOW) >= 0;
}

/**
 * True when the file declares an encryption dictionary.
 *
 * ## The test, and why it is this one
 *
 * A PDF is encrypted iff its trailer dictionary carries an `/Encrypt` entry
 * (ISO 32000-1 §7.6.1). The entry is *always* an indirect reference — the spec
 * requires it, because the encryption dictionary must be a separate object so
 * that it is itself left unencrypted — so it is written `/Encrypt 42 0 R`.
 *
 * That exact shape is what is matched here: the literal `/Encrypt`, then
 * whitespace, then a digit. The naive version of this check (`/Encrypt` appears
 * anywhere) is the one most tools ship and it has a real false-positive: the
 * byte sequence can occur inside an *unencrypted* PDF's content stream, its
 * metadata, or a font name. Requiring the reference syntax after it removes
 * essentially all of that, because prose containing "/Encrypt" is not followed
 * by an object number.
 *
 * ## What it does not do
 *
 * It scans the whole buffer rather than locating the trailer, and that is a
 * deliberate simplification with a stated cost. Finding the real trailer means
 * following `startxref`, and then handling PDF 1.5+ cross-reference *streams*,
 * where the trailer dictionary lives inside a compressed object and `/Encrypt`
 * would not be visible as plaintext at all. A whole-buffer scan needs none of
 * that machinery and errs toward *detecting* encryption, which is the right
 * direction to err: a false positive costs a user one clear, correctable
 * rejection message; a false negative costs a billed extraction call that
 * returns garbage.
 *
 * The residual false negative — an encrypted PDF using a cross-reference stream,
 * where `/Encrypt` is itself compressed — is real and is not closed here. It
 * degrades to the extraction step failing, which is the behaviour we already
 * have to handle, rather than to anything unsafe.
 */
export function looksEncrypted(bytes: Uint8Array): boolean {
  let cursor = 0;

  for (;;) {
    const found = indexOfBytes(bytes, ENCRYPT_KEY, cursor);
    if (found < 0) return false;

    let after = found + ENCRYPT_KEY.length;

    // `/EncryptMetadata` is a *different* key, and it appears in plenty of
    // unencrypted files. Requiring a delimiter after `/Encrypt` rules it out
    // before the reference check even runs.
    if (isPdfWhitespace(bytes[after])) {
      while (isPdfWhitespace(bytes[after])) after += 1;
      if (isAsciiDigit(bytes[after])) return true;
    }

    cursor = found + 1;
  }
}

/**
 * True when the file has an `%%EOF` marker.
 *
 * Not currently a rejection on its own — a PDF can be missing it and still open
 * — but it separates "truncated upload" from "not a PDF at all" in the
 * diagnostics, and a truncated upload is the failure a resumable TUS transfer is
 * most likely to produce.
 */
export function hasEofMarker(bytes: Uint8Array): boolean {
  const marker = asciiBytes("%%EOF");
  // The marker is at the end, possibly followed by trailing whitespace.
  for (let i = bytes.length - marker.length; i >= Math.max(0, bytes.length - 2048); i -= 1) {
    if (matchesAt(bytes, i, marker)) return true;
  }
  return false;
}
