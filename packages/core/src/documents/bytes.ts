/**
 * Byte primitives for the document validators.
 *
 * ## Why these exist rather than `TextDecoder` / `Buffer`
 *
 * `packages/core` compiles against `lib: ["ES2023"]` only — no DOM, no
 * `@types/node`. That is the boundary rule, and it is worth keeping here rather
 * than carving an exception for: this module is imported by the browser (the
 * pre-upload check), by a Vercel Node function (the `validate` step) and by
 * Vitest, and the one shared vocabulary all three definitely agree on is
 * `Uint8Array` plus arithmetic.
 *
 * So there is no `TextDecoder` below. Every comparison is done on bytes, and the
 * one place a string is produced (`asciiFrom`) is deliberately ASCII-only: the
 * only names it is ever pointed at are ZIP central-directory entries for OOXML
 * packages, which are `[Content_Types].xml`, `ppt/slides/slide1.xml` and
 * friends. Non-ASCII bytes come back as U+FFFD instead of throwing, because a
 * weird filename inside an archive is not a reason to fail a validation that is
 * only ever asking "does any entry start with `ppt/`".
 */

/** Reads a little-endian uint16. Returns `null` past the end rather than NaN. */
export function readU16LE(bytes: Uint8Array, offset: number): number | null {
  const a = bytes[offset];
  const b = bytes[offset + 1];
  if (a === undefined || b === undefined) return null;
  return a | (b << 8);
}

/**
 * Reads a little-endian uint32.
 *
 * `>>> 0` is load-bearing: `<<` in JavaScript operates on *signed* 32-bit
 * integers, so a value with the high bit set (anything ≥ 2 GiB — exactly the
 * range a zip-bomb guard cares about) would come back negative and compare as
 * smaller than the threshold it is supposed to trip.
 */
export function readU32LE(bytes: Uint8Array, offset: number): number | null {
  const a = bytes[offset];
  const b = bytes[offset + 1];
  const c = bytes[offset + 2];
  const d = bytes[offset + 3];
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return (a | (b << 8) | (c << 16) | (d << 24)) >>> 0;
}

/**
 * Reads a little-endian uint64 as a JS number.
 *
 * ZIP64 sizes are 64-bit. A `number` holds integers exactly up to 2^53, and
 * every threshold this package checks is measured in hundreds of megabytes, so
 * precision loss can only occur on values that are already astronomically over
 * every limit. Returns `null` past the end.
 */
export function readU64LE(bytes: Uint8Array, offset: number): number | null {
  const low = readU32LE(bytes, offset);
  const high = readU32LE(bytes, offset + 4);
  if (low === null || high === null) return null;
  return high * 0x1_0000_0000 + low;
}

/** The 4-byte little-endian signature at `offset`, or `null` past the end. */
export function readSignature(bytes: Uint8Array, offset: number): number | null {
  return readU32LE(bytes, offset);
}

/** True when `needle` appears at exactly `offset`. */
export function matchesAt(bytes: Uint8Array, offset: number, needle: readonly number[]): boolean {
  if (offset < 0 || offset + needle.length > bytes.length) return false;
  for (let i = 0; i < needle.length; i += 1) {
    if (bytes[offset + i] !== needle[i]) return false;
  }
  return true;
}

/**
 * First index of `needle` at or after `from`, bounded by `until` (exclusive).
 *
 * Naive scan, on purpose. The inputs are ≤ 50 MB and the needles are 5–8 bytes,
 * so this is a few tens of milliseconds at worst on the one code path that ever
 * sees a whole file — and a Boyer-Moore table would be more code to get wrong
 * than the time it saves inside a job step with a 800 s budget.
 */
export function indexOfBytes(
  bytes: Uint8Array,
  needle: readonly number[],
  from = 0,
  until = bytes.length,
): number {
  const first = needle[0];
  if (first === undefined) return -1;
  const limit = Math.min(until, bytes.length) - needle.length;
  for (let i = Math.max(0, from); i <= limit; i += 1) {
    if (bytes[i] === first && matchesAt(bytes, i, needle)) return i;
  }
  return -1;
}

/** Last index of `needle` at or before `from`, searching backwards. */
export function lastIndexOfBytes(
  bytes: Uint8Array,
  needle: readonly number[],
  from: number,
): number {
  const start = Math.min(from, bytes.length - needle.length);
  for (let i = start; i >= 0; i -= 1) {
    if (matchesAt(bytes, i, needle)) return i;
  }
  return -1;
}

/** ASCII bytes of a literal, for use as a needle. */
export function asciiBytes(text: string): readonly number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) out.push(text.charCodeAt(i) & 0xff);
  return out;
}

/** ASCII text from a byte range. Non-ASCII becomes U+FFFD; never throws. */
export function asciiFrom(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  const end = Math.min(offset + length, bytes.length);
  for (let i = offset; i < end; i += 1) {
    const byte = bytes[i];
    if (byte === undefined) break;
    out += byte < 0x80 ? String.fromCharCode(byte) : "�";
  }
  return out;
}

const ASCII_SPACE = 0x20;
const ASCII_TAB = 0x09;
const ASCII_LF = 0x0a;
const ASCII_CR = 0x0d;
const ASCII_FF = 0x0c;
const ASCII_NUL = 0x00;

/** PDF's definition of whitespace (ISO 32000-1 table 1). */
export function isPdfWhitespace(byte: number | undefined): boolean {
  return (
    byte === ASCII_SPACE ||
    byte === ASCII_TAB ||
    byte === ASCII_LF ||
    byte === ASCII_CR ||
    byte === ASCII_FF ||
    byte === ASCII_NUL
  );
}

/** True for ASCII `0`–`9`. */
export function isAsciiDigit(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x30 && byte <= 0x39;
}
