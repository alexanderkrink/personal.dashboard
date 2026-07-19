import { describe, expect, it } from "vitest";
import { buildDocx, buildPptx, buildZip, bytesOf } from "./__fixtures__/build-zip";
import { formatBytes, MAX_ARCHIVE_INFLATED_BYTES, MAX_DOCUMENT_BYTES } from "./limits";
import { countPdfPages, looksEncrypted, looksLikePdf } from "./pdf";
import { guessDocumentKind, validateDocument, validateDocumentSize } from "./validate";
import { readZipDirectory } from "./zip";

/** A minimal but structurally real PDF. */
const MINIMAL_PDF = bytesOf(
  "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\nstartxref\n0\n%%EOF\n",
);

/** The same, with an encryption dictionary referenced from the trailer. */
const ENCRYPTED_PDF = bytesOf(
  "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R /Encrypt 9 0 R /ID [<ab><cd>] >>\nstartxref\n0\n%%EOF\n",
);

describe("validateDocumentSize", () => {
  it("accepts a file inside the cap by returning no rejection", () => {
    expect(validateDocumentSize({ sizeBytes: 1_015_675, filename: "s01-basics.pdf" })).toBeNull();
  });

  it("accepts a file exactly at the cap — the limit is inclusive", () => {
    expect(
      validateDocumentSize({ sizeBytes: MAX_DOCUMENT_BYTES, filename: "edge.pdf" }),
    ).toBeNull();
  });

  it("rejects one byte over the cap", () => {
    const verdict = validateDocumentSize({
      sizeBytes: MAX_DOCUMENT_BYTES + 1,
      filename: "edge.pdf",
    });
    expect(verdict?.ok).toBe(false);
    if (verdict?.ok === false) expect(verdict.rejection.code).toBe("too-large");
  });

  it("rejects an empty file with advice rather than a size", () => {
    const verdict = validateDocumentSize({ sizeBytes: 0, filename: "empty.pdf" });
    expect(verdict?.ok).toBe(false);
    if (verdict?.ok === false) {
      expect(verdict.rejection.code).toBe("empty");
      expect(verdict.rejection.message).toContain("empty");
    }
  });

  /**
   * The specific requirement from PLAN §2's DECIDED note of 2026-07-18, pinned
   * against the exact byte count of the real over-cap fixture
   * (`.local-fixtures/book/kotler-principles-of-marketing.pdf`). The file itself
   * is gitignored, so its SIZE is asserted here and the real bytes are exercised
   * by the apps/web tier-2 test.
   */
  it("states the actual size, the limit and the fix for the real oversized book", () => {
    const verdict = validateDocumentSize({
      sizeBytes: 163_918_977,
      filename: "kotler-principles-of-marketing.pdf",
    });

    expect(verdict?.ok).toBe(false);
    if (verdict?.ok !== false) return;

    const { message } = verdict.rejection;
    expect(message).toContain("kotler-principles-of-marketing.pdf");
    expect(message).toContain("156 MB"); // the actual size
    expect(message).toContain("50 MB"); // the limit
    expect(message).toMatch(/compress/i); // the fix
    expect(message).toMatch(/split/i);
    // Never a generic failure, and never machine wreckage.
    expect(message).not.toMatch(/error|invalid|failed|null|undefined/i);
  });
});

describe("formatBytes", () => {
  it.each([
    [0, "0 bytes"],
    [512, "512 bytes"],
    [1024, "1 KB"],
    // The real s01-basics.pdf. Binary prefixes, so 1,015,675 bytes is 992 KB —
    // not "1 MB", which is what a decimal reading would print.
    [1_015_675, "992 KB"],
    [52_428_800, "50 MB"],
    [163_918_977, "156 MB"],
  ])("formats %i as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe("magic-byte sniffing (never the extension)", () => {
  it("accepts a PDF regardless of what it is named", () => {
    const verdict = validateDocument({ bytes: MINIMAL_PDF, filename: "lecture.pptx" });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.document.format).toBe("pdf");
  });

  it("rejects a text file named .pdf", () => {
    const verdict = validateDocument({
      bytes: bytesOf("Dear professor, please find attached\n"),
      filename: "reading.pdf",
      declaredMimeType: "application/pdf",
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rejection.code).toBe("unreadable-format");
  });

  it("rejects a PPTX named .pdf as slides, not as a PDF", () => {
    const verdict = validateDocument({ bytes: buildPptx(), filename: "deck.pdf" });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.document.format).toBe("pptx");
  });

  it("tolerates leading junk before %PDF- within the first KB", () => {
    const junk = new Uint8Array(200).fill(0x20);
    const bytes = new Uint8Array(junk.length + MINIMAL_PDF.length);
    bytes.set(junk);
    bytes.set(MINIMAL_PDF, junk.length);
    expect(looksLikePdf(bytes)).toBe(true);
  });

  it("does not find a %PDF- header beyond the first KB", () => {
    const junk = new Uint8Array(2000).fill(0x20);
    const bytes = new Uint8Array(junk.length + MINIMAL_PDF.length);
    bytes.set(junk);
    bytes.set(MINIMAL_PDF, junk.length);
    expect(looksLikePdf(bytes)).toBe(false);
  });
});

describe("encrypted PDF detection", () => {
  it("detects an /Encrypt indirect reference", () => {
    expect(looksEncrypted(ENCRYPTED_PDF)).toBe(true);
  });

  it("rejects an encrypted PDF with the password, not the pipeline, as the fix", () => {
    const verdict = validateDocument({ bytes: ENCRYPTED_PDF, filename: "chapter-4.pdf" });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.rejection.code).toBe("encrypted-pdf");
    expect(verdict.rejection.message).toMatch(/password/i);
    expect(verdict.rejection.message).toContain("chapter-4.pdf");
  });

  it("does not fire on /EncryptMetadata, which unencrypted files carry", () => {
    expect(looksEncrypted(bytesOf("%PDF-1.7\n<< /EncryptMetadata true >>\n%%EOF"))).toBe(false);
  });

  it("does not fire on the word appearing in prose without an object reference", () => {
    expect(looksEncrypted(bytesOf("%PDF-1.7\n(Slide 3: how to /Encrypt your data)\n%%EOF"))).toBe(
      false,
    );
  });

  it("still fires when /Encrypt is separated from its reference by a newline", () => {
    expect(looksEncrypted(bytesOf("%PDF-1.7\ntrailer << /Encrypt\n  12 0 R >>\n%%EOF"))).toBe(true);
  });
});

describe("zip-bomb guard", () => {
  it("reads a well-formed PPTX central directory without decompressing", () => {
    const result = readZipDirectory(buildPptx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.directory.entryCount).toBe(3);
      expect(result.directory.ooxml).toBe("pptx");
      expect(result.directory.hasContentTypes).toBe(true);
    }
  });

  it("refuses an archive that DECLARES more than the inflated cap", () => {
    // One entry claiming 300 MB. The archive on disk is a few hundred bytes —
    // which is precisely the shape of a bomb, and precisely why the declaration
    // rather than the payload is what gets measured.
    const bomb = buildPptx([{ name: "ppt/media/image1.png", declaredSize: 300 * 1024 * 1024 }]);
    expect(bomb.length).toBeLessThan(1024);

    const verdict = validateDocument({ bytes: bomb, filename: "deck.pptx" });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.rejection.code).toBe("archive-too-large");
    expect(verdict.rejection.message).toContain("300 MB");
    expect(verdict.rejection.message).toContain(formatBytes(MAX_ARCHIVE_INFLATED_BYTES));
  });

  it("refuses an archive with more than 1,000 entries", () => {
    const entries = Array.from({ length: 1200 }, (_, index) => ({
      name: `ppt/slides/slide${index}.xml`,
    }));
    const verdict = validateDocument({
      bytes: buildZip([{ name: "[Content_Types].xml" }, ...entries]),
      filename: "deck.pptx",
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.rejection.code).toBe("archive-too-many-entries");
    expect(verdict.rejection.message).toContain("1,201");
  });

  it("accepts an archive sitting just under both caps", () => {
    // The cap is on the SUM of declared sizes, so the headroom has to cover the
    // package's other parts too — buildPptx contributes three small entries.
    const verdict = validateDocument({
      bytes: buildPptx([
        { name: "ppt/media/image1.png", declaredSize: MAX_ARCHIVE_INFLATED_BYTES - 1000 },
      ]),
      filename: "deck.pptx",
    });
    expect(verdict.ok).toBe(true);
  });

  it("reads ZIP64 entry sizes rather than the 32-bit sentinel", () => {
    // 5 GiB declared: the 32-bit field is escaped and the real size lives in the
    // entry's ZIP64 extra field. Read naively this would be 4,294,967,295 —
    // still over the cap, so the test asserts the reported figure, not just the
    // rejection.
    const verdict = validateDocument({
      bytes: buildPptx([{ name: "ppt/media/huge.mp4", declaredSize: 5 * 1024 * 1024 * 1024 }]),
      filename: "deck.pptx",
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.rejection.message).toContain("5 GB");
  });

  it("reads a ZIP64 end-of-central-directory record", () => {
    const result = readZipDirectory(buildPptx().slice()); // sanity: non-ZIP64 path
    expect(result.ok).toBe(true);

    const zip64 = readZipDirectory(
      buildZip([{ name: "[Content_Types].xml" }, { name: "ppt/presentation.xml" }], {
        zip64: true,
      }),
    );
    expect(zip64.ok).toBe(true);
    if (zip64.ok) expect(zip64.directory.entryCount).toBe(2);
  });

  it("refuses ZIP64 sentinels with no ZIP64 record behind them", () => {
    const result = readZipDirectory(
      buildZip([{ name: "ppt/presentation.xml" }], { zip64WithoutRecords: true }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed-zip64");
  });

  it("finds the EOCD behind a trailing archive comment", () => {
    const result = readZipDirectory(buildPptx().slice());
    expect(result.ok).toBe(true);

    const commented = readZipDirectory(
      buildZip([{ name: "ppt/presentation.xml" }], { comment: "x".repeat(4096) }),
    );
    expect(commented.ok).toBe(true);
  });

  it("treats a directory that ends early as a damaged upload, not a wrong file", () => {
    const verdict = validateDocument({
      bytes: buildZip([{ name: "ppt/presentation.xml" }], { overstateEntryCount: 40 }),
      filename: "deck.pptx",
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.rejection.code).toBe("damaged-archive");
    expect(verdict.rejection.message).toMatch(/interrupted|again/i);
  });
});

describe("recognised but unsupported formats", () => {
  it("tells a Word user to export as PDF", () => {
    const verdict = validateDocument({ bytes: buildDocx(), filename: "bdba-loes-fall2025.docx" });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.rejection.code).toBe("unsupported-format");
    expect(verdict.rejection.message).toMatch(/Word/);
    expect(verdict.rejection.message).toMatch(/export as PDF/i);
  });

  it("tells a plain-zip user to unzip first", () => {
    const verdict = validateDocument({
      bytes: buildZip([{ name: "notes/readme.txt" }]),
      filename: "week3.zip",
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.rejection.message).toMatch(/unzip/i);
  });
});

describe("every rejection message is fit for a user to read", () => {
  const cases: ReadonlyArray<readonly [string, Uint8Array | number]> = [
    ["oversized", MAX_DOCUMENT_BYTES + 1],
    ["empty", 0],
    ["encrypted", ENCRYPTED_PDF],
    ["not a document", bytesOf("hello")],
    ["a Word file", buildDocx()],
    ["a bomb", buildPptx([{ name: "ppt/media/x.png", declaredSize: 900 * 1024 * 1024 }])],
  ];

  it.each(cases)("%s reads as a sentence with a next step", (_label, input) => {
    const verdict =
      typeof input === "number"
        ? validateDocumentSize({ sizeBytes: input, filename: "file.pdf" })
        : validateDocument({ bytes: input, filename: "file.pdf" });

    expect(verdict?.ok).toBe(false);
    if (verdict?.ok !== false) return;

    const { message } = verdict.rejection;
    // Ends like a sentence, starts like one, and never leaks machinery.
    expect(message.length).toBeGreaterThan(30);
    expect(message.trimEnd().endsWith(".")).toBe(true);
    expect(message).not.toMatch(/\bat [A-Za-z]+ \(|Error:|\bstack\b|node_modules|undefined|NaN/);
    // Actionable: every message tells the user to do something.
    expect(message).toMatch(/upload|export|compress|split|unzip|open|check|try/i);
  });
});

describe("guessDocumentKind", () => {
  it.each([
    ["mathematics-syllabus.pdf", "syllabus"],
    ["bdba-loes-fall2025.docx", "syllabus"],
    ["s01-basics.pptx", "slides"],
    ["Micro - Unit 3- Elasticities (2026).pptx", "slides"],
    ["s03-marketplace-analysis-chp2.pdf", "slides"],
    ["kotler-principles-of-marketing.pdf", "reading"],
    ["harvard-case-southwest.pdf", "case"],
  ] as const)("guesses %s as %s", (filename, expected) => {
    expect(guessDocumentKind({ filename })).toBe(expected);
  });

  it("falls back on format when the name carries no signal", () => {
    expect(guessDocumentKind({ filename: "document.pptx", format: "pptx" })).toBe("slides");
    expect(guessDocumentKind({ filename: "document.pdf", format: "pdf" })).toBe("reading");
  });

  /**
   * Pinned as a KNOWN MISS rather than fixed, because it is the honest reason
   * the dialog makes `kind` an editable field instead of an inference. This is a
   * real syllabus from the real corpus whose filename says nothing about that;
   * no amount of pattern-tuning reads "syllabus" out of it, and a guess that
   * tried would start mislabelling ordinary readings. The guess is a default,
   * and the user is the authority.
   */
  it("misses a real syllabus whose filename carries no syllabus signal", () => {
    expect(guessDocumentKind({ filename: "marketing-fundamentals-sem1.pdf" })).toBe("reading");
  });
});

describe("countPdfPages", () => {
  /**
   * A hint to the extraction prompt, never a gate — so the interesting behaviour is the
   * `null`. A confidently wrong page count would make the model's own coverage accounting
   * wrong, which is worse than not telling it.
   */
  const pdf = (body: string): Uint8Array => new TextEncoder().encode(`%PDF-1.7\n${body}\n%%EOF`);

  it("counts pages when the object count and the declared /Count agree", () => {
    expect(
      countPdfPages(pdf("/Type /Pages /Count 3\n/Type /Page x\n/Type /Page y\n/Type /Page z")),
    ).toBe(3);
  });

  it("returns null when the two signals disagree", () => {
    expect(countPdfPages(pdf("/Type /Pages /Count 9\n/Type /Page x\n/Type /Page y"))).toBeNull();
  });

  it("returns null when page objects are not visible (object streams)", () => {
    expect(countPdfPages(pdf("/Type /Pages /Count 12\n<compressed object stream>"))).toBeNull();
  });

  it("returns null when nothing declares a count", () => {
    expect(countPdfPages(pdf("/Type /Page x\n/Type /Page y"))).toBeNull();
  });

  it("does not mistake /Pages for a page object", () => {
    // `/Type /Pages` is the tree node, not a page. Counting it would be off by one on
    // every PDF in existence.
    expect(countPdfPages(pdf("/Type /Pages /Count 1\n/Type /Page a"))).toBe(1);
  });

  it("takes the root's count when nested /Pages nodes declare their own", () => {
    expect(
      countPdfPages(
        pdf(
          "/Type /Pages /Count 4\n/Type /Pages /Count 2\n/Type /Page a\n/Type /Page b\n/Type /Page c\n/Type /Page d",
        ),
      ),
    ).toBe(4);
  });
});
