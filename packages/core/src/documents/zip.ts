/**
 * A read-only walk of a ZIP central directory.
 *
 * ## Why the central directory and not the archive
 *
 * This module never decompresses a byte, and that is the entire point of it as
 * a zip-bomb guard. A bomb works by being small on disk and enormous in memory,
 * so any guard that has to inflate the archive to measure it has already lost —
 * it is the inflation itself that is the attack. The central directory sits at
 * the end of every ZIP and *declares* each entry's uncompressed size, so the
 * declared total can be summed and refused before a single stream is touched.
 *
 * The trade is that a lying header is possible: an archive can declare 1 KB and
 * inflate to a gigabyte. That is a real gap and it is not closed here, because
 * closing it requires bounded decompression, which belongs with whoever actually
 * unzips the file (PLAN §4.2's `jszip` path — Agent 3's extraction step, which
 * should cap its own output). What this module guarantees is narrower and worth
 * stating exactly: **an archive that honestly declares itself oversized is
 * refused for free, before download, before extraction, before any memory is
 * committed.** Every real-world PPTX declares honestly, because the same numbers
 * are what any unzipper uses to allocate.
 *
 * ## Also: what kind of OOXML package this is
 *
 * A `.pptx`, `.docx` and `.xlsx` are all ZIPs, indistinguishable by magic bytes
 * — all three start `PK\x03\x04`. They are told apart by their part names, so
 * the same directory walk that measures the archive also reports whether it saw
 * a `ppt/`, `word/` or `xl/` prefix. This is what makes the format sniff
 * genuinely content-based rather than extension-based for the OOXML half: a
 * `.pptx` that is really a Word file is caught here, not by trusting its name.
 */

import { asciiFrom, lastIndexOfBytes, readU16LE, readU32LE, readU64LE } from "./bytes";

const EOCD_SIGNATURE = [0x50, 0x4b, 0x05, 0x06] as const; // "PK\x05\x06"
const ZIP64_EOCD_LOCATOR_SIGNATURE = [0x50, 0x4b, 0x06, 0x07] as const; // "PK\x06\x07"
const ZIP64_EOCD_SIGNATURE = [0x50, 0x4b, 0x06, 0x06] as const; // "PK\x06\x06"
const CENTRAL_FILE_HEADER_SIGNATURE = 0x0201_4b50; // "PK\x01\x02" little-endian

/** The ZIP64 escape values: a 32-bit field set to all-ones means "read ZIP64". */
const U16_SENTINEL = 0xffff;
const U32_SENTINEL = 0xffff_ffff;

const EOCD_MIN_SIZE = 22;
/** A ZIP comment is a uint16 length, so the EOCD starts at most 65535+22 from the end. */
const MAX_EOCD_SEARCH = 0xffff + EOCD_MIN_SIZE;

export type OoxmlKind = "pptx" | "docx" | "xlsx";

export interface ZipDirectory {
  readonly entryCount: number;
  /** Sum of the entries' DECLARED uncompressed sizes. See the note above. */
  readonly declaredInflatedBytes: number;
  /** Which OOXML package this looks like, from the part names. `null` if none matched. */
  readonly ooxml: OoxmlKind | null;
  /** True when `[Content_Types].xml` is present — the OOXML package marker. */
  readonly hasContentTypes: boolean;
}

export type ZipReadFailure =
  | "not-a-zip"
  | "truncated"
  /** Entry count or directory offset needed ZIP64 fields that are absent or unreadable. */
  | "malformed-zip64"
  | "malformed-directory";

export type ZipReadResult =
  | { readonly ok: true; readonly directory: ZipDirectory }
  | { readonly ok: false; readonly reason: ZipReadFailure };

interface Eocd {
  readonly entryCount: number;
  readonly directoryOffset: number;
}

/**
 * Finds the End Of Central Directory record.
 *
 * Searched backwards because the EOCD is last, and its position is only
 * *bounded* rather than fixed: a trailing comment of up to 65535 bytes may sit
 * after it. Scanning back from the end finds the real one first; scanning
 * forwards would find any `PK\x05\x06` that happened to occur inside compressed
 * data.
 */
function findEocd(bytes: Uint8Array): Eocd | ZipReadFailure {
  const searchFloor = Math.max(0, bytes.length - MAX_EOCD_SEARCH);
  const eocdOffset = lastIndexOfBytes(bytes, EOCD_SIGNATURE, bytes.length - EOCD_MIN_SIZE);
  if (eocdOffset < 0 || eocdOffset < searchFloor) return "not-a-zip";

  let entryCount = readU16LE(bytes, eocdOffset + 10);
  let directoryOffset = readU32LE(bytes, eocdOffset + 16);
  if (entryCount === null || directoryOffset === null) return "truncated";

  // ZIP64: either field maxed out means the true value lives in the ZIP64 EOCD,
  // which is located via a locator record sitting immediately before the EOCD.
  if (entryCount === U16_SENTINEL || directoryOffset === U32_SENTINEL) {
    const locatorOffset = lastIndexOfBytes(bytes, ZIP64_EOCD_LOCATOR_SIGNATURE, eocdOffset);
    if (locatorOffset < 0) return "malformed-zip64";

    const zip64Offset = readU64LE(bytes, locatorOffset + 8);
    if (zip64Offset === null || zip64Offset < 0 || zip64Offset + 56 > bytes.length) {
      return "malformed-zip64";
    }

    const signature = readU32LE(bytes, zip64Offset);
    const expected =
      (ZIP64_EOCD_SIGNATURE[0] |
        (ZIP64_EOCD_SIGNATURE[1] << 8) |
        (ZIP64_EOCD_SIGNATURE[2] << 16) |
        (ZIP64_EOCD_SIGNATURE[3] << 24)) >>>
      0;
    if (signature !== expected) return "malformed-zip64";

    const zip64Count = readU64LE(bytes, zip64Offset + 32);
    const zip64DirOffset = readU64LE(bytes, zip64Offset + 48);
    if (zip64Count === null || zip64DirOffset === null) return "malformed-zip64";

    entryCount = zip64Count;
    directoryOffset = zip64DirOffset;
  }

  if (directoryOffset > bytes.length) return "truncated";
  return { entryCount, directoryOffset };
}

/**
 * Pulls a 64-bit size out of an entry's ZIP64 extra field when the 32-bit slot
 * is maxed out.
 *
 * The extra field is a sequence of `(headerId u16, size u16, payload)` blocks;
 * ZIP64's id is `0x0001` and its payload begins with uncompressed size then
 * compressed size — but *only for the fields that were actually escaped*, in
 * that order. Since this function is only called when the uncompressed slot is
 * the sentinel, uncompressed size is by definition the first 8 bytes.
 */
function readZip64UncompressedSize(
  bytes: Uint8Array,
  extraOffset: number,
  extraLength: number,
): number | null {
  let cursor = extraOffset;
  const end = extraOffset + extraLength;

  while (cursor + 4 <= end) {
    const headerId = readU16LE(bytes, cursor);
    const blockSize = readU16LE(bytes, cursor + 2);
    if (headerId === null || blockSize === null) return null;

    if (headerId === 0x0001) {
      if (blockSize < 8) return null;
      return readU64LE(bytes, cursor + 4);
    }
    cursor += 4 + blockSize;
  }
  return null;
}

/** Maps an OOXML part-name prefix to the package kind it implies. */
function ooxmlKindFor(name: string): OoxmlKind | null {
  if (name.startsWith("ppt/")) return "pptx";
  if (name.startsWith("word/")) return "docx";
  if (name.startsWith("xl/")) return "xlsx";
  return null;
}

/**
 * Reads the central directory: how many entries, how large they claim to
 * inflate to, and what kind of OOXML package (if any) the part names describe.
 *
 * Never decompresses. Never allocates proportional to the declared sizes — the
 * whole point is that a 10 GB declaration costs the same to refuse as a 10 KB
 * one.
 */
export function readZipDirectory(bytes: Uint8Array): ZipReadResult {
  const eocd = findEocd(bytes);
  if (typeof eocd === "string") return { ok: false, reason: eocd };

  let cursor = eocd.directoryOffset;
  let declaredInflatedBytes = 0;
  let seen = 0;
  let ooxml: OoxmlKind | null = null;
  let hasContentTypes = false;

  // Bounded by the declared entry count AND by the buffer, so a directory that
  // claims more entries than it contains terminates rather than spinning.
  while (seen < eocd.entryCount) {
    const signature = readU32LE(bytes, cursor);
    if (signature === null) return { ok: false, reason: "truncated" };
    if (signature !== CENTRAL_FILE_HEADER_SIGNATURE) {
      // The directory ended early (or never was one). Distinguished from
      // "truncated" because the bytes are present and simply are not a header.
      return { ok: false, reason: "malformed-directory" };
    }

    const uncompressed = readU32LE(bytes, cursor + 24);
    const nameLength = readU16LE(bytes, cursor + 28);
    const extraLength = readU16LE(bytes, cursor + 30);
    const commentLength = readU16LE(bytes, cursor + 32);
    if (
      uncompressed === null ||
      nameLength === null ||
      extraLength === null ||
      commentLength === null
    ) {
      return { ok: false, reason: "truncated" };
    }

    const nameOffset = cursor + 46;
    const extraOffset = nameOffset + nameLength;

    let size = uncompressed;
    if (size === U32_SENTINEL) {
      const zip64Size = readZip64UncompressedSize(bytes, extraOffset, extraLength);
      // A sentinel with no ZIP64 extra to back it is malformed. Treating it as
      // 4 GiB−1 would be the *safe* guess for a bomb guard, but it would also
      // silently accept a corrupt archive as merely large, so it fails instead.
      if (zip64Size === null) return { ok: false, reason: "malformed-zip64" };
      size = zip64Size;
    }
    declaredInflatedBytes += size;

    const name = asciiFrom(bytes, nameOffset, nameLength);
    if (name === "[Content_Types].xml") hasContentTypes = true;
    ooxml ??= ooxmlKindFor(name);

    cursor = extraOffset + extraLength + commentLength;
    seen += 1;

    if (cursor > bytes.length) return { ok: false, reason: "truncated" };
  }

  return {
    ok: true,
    directory: { entryCount: seen, declaredInflatedBytes, ooxml, hasContentTypes },
  };
}
