/**
 * A minimal ZIP writer, for tests only.
 *
 * The zip-bomb guard reads the central directory, so testing it needs archives
 * with *controlled* directory contents — including ones no real tool would emit
 * (an entry declaring 4 GB, a truncated directory, a ZIP64 escape with no ZIP64
 * record behind it). A fixture file cannot express those, and `jszip` cannot
 * either: it produces well-formed archives by construction, which is exactly the
 * case the guard does not need help with.
 *
 * Entries are STORED (compression method 0), so the declared uncompressed size
 * can be set independently of the payload — that separation is the whole point.
 * A real archive's declaration matches its contents; a bomb's does not; the
 * guard reads only the declaration, and these fixtures let both be expressed.
 */

export interface ZipEntrySpec {
  readonly name: string;
  /** Actual stored bytes. Defaults to empty. */
  readonly content?: Uint8Array;
  /**
   * What the headers should CLAIM the entry inflates to. Defaults to
   * `content.length`. Set it higher to build a lying archive.
   */
  readonly declaredSize?: number;
}

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function u64(value: number): number[] {
  const low = value >>> 0;
  const high = Math.floor(value / 0x1_0000_0000);
  return [...u32(low), ...u32(high)];
}

function ascii(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) out.push(text.charCodeAt(i) & 0xff);
  return out;
}

export interface BuildZipOptions {
  /**
   * Force ZIP64 escapes into the EOCD (entry count / directory offset set to
   * their all-ones sentinels) and emit the ZIP64 records behind them.
   */
  readonly zip64?: boolean;
  /**
   * Write the ZIP64 sentinels but omit the ZIP64 records — the malformed case.
   */
  readonly zip64WithoutRecords?: boolean;
  /** Trailing archive comment, which pushes the EOCD away from the very end. */
  readonly comment?: string;
  /**
   * Overstate the EOCD's entry count without adding directory headers, so the
   * walk runs past the end of the directory.
   */
  readonly overstateEntryCount?: number;
}

/** Builds a ZIP whose central directory says exactly what the spec asked for. */
export function buildZip(
  entries: readonly ZipEntrySpec[],
  options: BuildZipOptions = {},
): Uint8Array {
  const out: number[] = [];
  const localOffsets: number[] = [];

  for (const entry of entries) {
    const content = entry.content ?? new Uint8Array(0);
    const declared = entry.declaredSize ?? content.length;
    const name = ascii(entry.name);

    localOffsets.push(out.length);
    out.push(
      ...u32(0x0403_4b50), // local file header signature
      ...u16(20), // version needed
      ...u16(0), // flags
      ...u16(0), // stored
      ...u16(0), // mod time
      ...u16(0), // mod date
      ...u32(0), // crc32 — not checked by the guard
      ...u32(content.length), // compressed size
      ...u32(declared), // uncompressed size
      ...u16(name.length),
      ...u16(0), // extra length
      ...name,
      ...content,
    );
  }

  const directoryOffset = out.length;

  for (const [index, entry] of entries.entries()) {
    const content = entry.content ?? new Uint8Array(0);
    const declared = entry.declaredSize ?? content.length;
    const name = ascii(entry.name);
    const localOffset = localOffsets[index] ?? 0;

    // A declared size at or above the 32-bit ceiling has to be escaped into a
    // ZIP64 extra field, exactly as a real writer would do it.
    const needsZip64 = declared >= 0xffff_ffff;
    const extra = needsZip64 ? [...u16(0x0001), ...u16(8), ...u64(declared)] : [];

    out.push(
      ...u32(0x0201_4b50), // central file header signature
      ...u16(20), // version made by
      ...u16(20), // version needed
      ...u16(0), // flags
      ...u16(0), // stored
      ...u16(0), // mod time
      ...u16(0), // mod date
      ...u32(0), // crc32
      ...u32(content.length), // compressed size
      ...u32(needsZip64 ? 0xffff_ffff : declared), // uncompressed size
      ...u16(name.length),
      ...u16(extra.length),
      ...u16(0), // comment length
      ...u16(0), // disk number start
      ...u16(0), // internal attributes
      ...u32(0), // external attributes
      ...u32(localOffset),
      ...name,
      ...extra,
    );
  }

  const directorySize = out.length - directoryOffset;
  const declaredCount = options.overstateEntryCount ?? entries.length;
  const useZip64Sentinels = options.zip64 === true || options.zip64WithoutRecords === true;

  if (options.zip64 === true) {
    const zip64Offset = out.length;
    out.push(
      ...u32(0x0606_4b50), // ZIP64 end of central directory record
      ...u64(44), // size of this record minus 12
      ...u16(45), // version made by
      ...u16(45), // version needed
      ...u32(0), // disk number
      ...u32(0), // disk with central directory
      ...u64(entries.length), // entries on this disk
      ...u64(entries.length), // total entries
      ...u64(directorySize),
      ...u64(directoryOffset),
      ...u32(0x0706_4b50), // ZIP64 locator signature
      ...u32(0), // disk with ZIP64 EOCD
      ...u64(zip64Offset),
      ...u32(1), // total disks
    );
  }

  const comment = ascii(options.comment ?? "");
  out.push(
    ...u32(0x0605_4b50), // EOCD signature
    ...u16(0), // disk number
    ...u16(0), // disk with central directory
    ...u16(useZip64Sentinels ? 0xffff : declaredCount),
    ...u16(useZip64Sentinels ? 0xffff : declaredCount),
    ...u32(directorySize),
    ...u32(useZip64Sentinels ? 0xffff_ffff : directoryOffset),
    ...u16(comment.length),
    ...comment,
  );

  return Uint8Array.from(out);
}

/** A believable `.pptx`: the OOXML marker part plus a couple of slides. */
export function buildPptx(extra: readonly ZipEntrySpec[] = []): Uint8Array {
  return buildZip([
    { name: "[Content_Types].xml", content: Uint8Array.from(ascii("<Types/>")) },
    { name: "ppt/presentation.xml", content: Uint8Array.from(ascii("<p:presentation/>")) },
    { name: "ppt/slides/slide1.xml", content: Uint8Array.from(ascii("<p:sld/>")) },
    ...extra,
  ]);
}

/** A believable `.docx`, for the "recognised but unsupported" path. */
export function buildDocx(): Uint8Array {
  return buildZip([
    { name: "[Content_Types].xml", content: Uint8Array.from(ascii("<Types/>")) },
    { name: "word/document.xml", content: Uint8Array.from(ascii("<w:document/>")) },
  ]);
}

/** Bytes of an ASCII string, for building synthetic PDFs. */
export function bytesOf(text: string): Uint8Array {
  return Uint8Array.from(ascii(text));
}
