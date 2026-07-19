import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  countWords,
  extractPptx,
  isVisualDeck,
  PptxExtractionError,
  VISUAL_DECK_WORDS_PER_SLIDE,
} from "./pptx";

/**
 * The PPTX text path (PLAN §4.2 v1).
 *
 * The tests that matter most here are the two **mapping** ones — notes-to-slide and
 * presentation order — because both are cases where the naive implementation produces
 * plausible, well-formed, wrong output. A parser that silently attaches slide 3's lecture
 * notes to slide 1 passes every "did it extract text?" check ever written.
 */

// ── Fixture builders ──────────────────────────────────────────────────────────

/** Wraps paragraphs in the minimum valid slide XML, optionally with a title placeholder. */
function slideXml(options: { title?: string; body?: readonly string[] }): string {
  const shape = (paragraphs: readonly string[], placeholder: string | null): string =>
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${
      placeholder === null ? "" : `<p:ph type="${placeholder}"/>`
    }</p:nvPr></p:nvSpPr><p:txBody>${paragraphs
      .map((text) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`)
      .join("")}</p:txBody></p:sp>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${
    options.title === undefined ? "" : shape([options.title], "title")
  }${options.body === undefined ? "" : shape(options.body, null)}</p:spTree></p:cSld></p:sld>`;
}

/**
 * A notesSlide. Includes a slide-number placeholder alongside the body, because real
 * decks always do and it is what makes the `body`-only filter worth testing.
 */
function notesXml(text: string, slideNumber: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="n"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="num"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum" idx="10"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${slideNumber}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
}

function relsXml(entries: ReadonlyArray<{ id: string; target: string; type?: string }>): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries
    .map(
      (entry) =>
        `<Relationship Id="${entry.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${entry.type ?? "slide"}" Target="${entry.target}"/>`,
    )
    .join("")}</Relationships>`;
}

interface SlideSpec {
  readonly title?: string;
  readonly body?: readonly string[];
  /** Index into the deck's `notes` array, i.e. which notesSlide part this slide owns. */
  readonly notesPart?: number;
}

/**
 * Builds a `.pptx`.
 *
 * `order` is the presentation order as a list of 1-based slide part numbers, so a test can
 * ship a deck whose running order differs from its file numbering.
 */
async function buildPptx(options: {
  slides: readonly SlideSpec[];
  notes?: readonly string[];
  order?: readonly number[];
}): Promise<Uint8Array> {
  const zip = new JSZip();
  const { slides, notes = [], order } = options;

  zip.file("[Content_Types].xml", "<Types/>");

  for (const [index, slide] of slides.entries()) {
    const number = index + 1;
    zip.file(`ppt/slides/slide${number}.xml`, slideXml(slide));
    zip.file(
      `ppt/slides/_rels/slide${number}.xml.rels`,
      relsXml(
        slide.notesPart === undefined
          ? [{ id: "rId1", target: "../slideLayouts/slideLayout1.xml", type: "slideLayout" }]
          : [
              { id: "rId1", target: "../slideLayouts/slideLayout1.xml", type: "slideLayout" },
              {
                id: "rId2",
                target: `../notesSlides/notesSlide${slide.notesPart}.xml`,
                type: "notesSlide",
              },
            ],
      ),
    );
  }

  for (const [index, text] of notes.entries()) {
    zip.file(`ppt/notesSlides/notesSlide${index + 1}.xml`, notesXml(text, String(index + 1)));
  }

  const running = order ?? slides.map((_, index) => index + 1);
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${running
      .map((part, index) => `<p:sldId id="${256 + index}" r:id="rId${part}"/>`)
      .join("")}</p:sldIdLst></p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    relsXml(
      slides.map((_, index) => ({ id: `rId${index + 1}`, target: `slides/slide${index + 1}.xml` })),
    ),
  );

  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("extractPptx", () => {
  it("pulls titles, body text and per-slide word counts", async () => {
    const bytes = await buildPptx({
      slides: [
        { title: "Supply and Demand", body: ["Price rises when supply falls."] },
        {
          title: "Elasticity",
          body: ["Elastic goods respond to price.", "Inelastic ones do not."],
        },
      ],
    });

    const result = await extractPptx(bytes);

    expect(result.slideCount).toBe(2);
    expect(result.slides[0]?.title).toBe("Supply and Demand");
    expect(result.slides[0]?.body).toEqual(["Price rises when supply falls."]);
    expect(result.slides[1]?.body).toHaveLength(2);
    // "Supply and Demand" (3) + "Price rises when supply falls." (5)
    expect(result.slides[0]?.slideWords).toBe(8);
  });

  /**
   * 🔴 The trap. Measured on the real corpus: `s01-basics.pptx` has 28 slides and 13
   * notesSlides, and `slide3` owns `notesSlide1`. Pairing by index would have put slide 3's
   * notes on slide 1 — well-formed, plausible, and wrong on every note in the deck.
   */
  it("resolves notes through the slide's relationship part, not by index", async () => {
    const bytes = await buildPptx({
      slides: [
        { title: "One" },
        { title: "Two" },
        { title: "Three", notesPart: 1 },
        { title: "Four" },
        { title: "Five", notesPart: 2 },
      ],
      notes: ["Attendance 80% required", "Mention the Kotler reading"],
    });

    const result = await extractPptx(bytes);

    expect(result.slides[2]?.notes).toBe("Attendance 80% required");
    expect(result.slides[4]?.notes).toBe("Mention the Kotler reading");
    // The slides that own no notesSlide must have none — an index-based reader would
    // have given slide 1 the first note and slide 2 the second.
    expect(result.slides[0]?.notes).toBeNull();
    expect(result.slides[1]?.notes).toBeNull();
    expect(result.slides[3]?.notes).toBeNull();
    expect(result.slidesWithNotes).toBe(2);
  });

  it("excludes the notesSlide's slide-number placeholder from the notes text", async () => {
    const bytes = await buildPptx({
      slides: [{ title: "One", notesPart: 1 }],
      notes: ["Real lecturer commentary"],
    });

    const result = await extractPptx(bytes);

    // The fixture's notesSlide also carries `<p:ph type="sldNum">` containing "1".
    expect(result.slides[0]?.notes).toBe("Real lecturer commentary");
    expect(result.slides[0]?.notes).not.toContain("1");
  });

  it("orders slides by the presentation's running order, not the file numbering", async () => {
    const bytes = await buildPptx({
      slides: [{ title: "Alpha" }, { title: "Beta" }, { title: "Gamma" }],
      // The deck was reordered in PowerPoint: slide3 now runs first.
      order: [3, 1, 2],
    });

    const result = await extractPptx(bytes);

    expect(result.slides.map((slide) => slide.title)).toEqual(["Gamma", "Alpha", "Beta"]);
    // `part` keeps the provenance, so a citation can still be traced to the source part.
    expect(result.slides[0]?.part).toBe("slide3");
    expect(result.slides.map((slide) => slide.number)).toEqual([1, 2, 3]);
  });

  it("keeps a slide the presentation's running order omits", async () => {
    const bytes = await buildPptx({
      slides: [{ title: "Shown" }, { title: "Hidden" }],
      order: [1],
    });

    const result = await extractPptx(bytes);

    // Dropping it would be a silent loss — the exact category `skipped` exists to surface.
    expect(result.slideCount).toBe(2);
    expect(result.slides.map((slide) => slide.title)).toEqual(["Shown", "Hidden"]);
  });

  /**
   * The routing statistic drives a real branch (and a real bill), so what it counts is
   * load-bearing. PLAN measured words/slide from `ppt/slides/slide*.xml` only; folding
   * notes in would let a visual deck with thorough notes score as text-rich and skip the
   * conversion — the precise failure the measurement exists to prevent.
   */
  it("computes wordsPerSlide from slide bodies and excludes speaker notes", async () => {
    const bytes = await buildPptx({
      slides: [{ title: "A B", notesPart: 1 }, { title: "C D" }],
      notes: ["one two three four five six seven eight nine ten"],
    });

    const result = await extractPptx(bytes);

    expect(result.slideWords).toBe(4);
    expect(result.wordsPerSlide).toBe(2);
    expect(result.notesWords).toBe(10);
    // Notes are extracted and kept — they just get no vote on the routing decision.
    expect(result.slides[0]?.notes).toContain("one two three");
  });

  it("routes on the §4.2 threshold", async () => {
    const sparse = await extractPptx(
      await buildPptx({ slides: [{ title: "Segmentation" }, { title: "Targeting" }] }),
    );
    expect(sparse.wordsPerSlide).toBeLessThan(VISUAL_DECK_WORDS_PER_SLIDE);
    expect(isVisualDeck(sparse)).toBe(true);

    const wordy = await extractPptx(
      await buildPptx({
        slides: [
          { title: "Elasticity", body: [Array.from({ length: 60 }, () => "word").join(" ")] },
        ],
      }),
    );
    expect(wordy.wordsPerSlide).toBeGreaterThan(VISUAL_DECK_WORDS_PER_SLIDE);
    expect(isVisualDeck(wordy)).toBe(false);
  });

  it("renders tables as markdown rather than dropping them", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file(
      "ppt/slides/slide1.xml",
      `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Old view</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>New view</a:t></a:r></a:p></a:txBody></a:tc></a:tr><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Sell the product</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Build relationships</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>`,
    );
    const bytes = new Uint8Array(await zip.generateAsync({ type: "uint8array" }));

    const result = await extractPptx(bytes);

    expect(result.slides[0]?.tables).toEqual([
      [
        ["Old view", "New view"],
        ["Sell the product", "Build relationships"],
      ],
    ]);
    expect(result.slides[0]?.markdown).toContain("| Old view | New view |");
    expect(result.slides[0]?.markdown).toContain("| --- | --- |");
  });

  it("preserves spacing between adjacent formatted runs", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file(
      "ppt/slides/slide1.xml",
      `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>price </a:t></a:r><a:r><a:t>elasticity</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    );

    const result = await extractPptx(
      new Uint8Array(await zip.generateAsync({ type: "uint8array" })),
    );

    // Trimming each run would weld these into "priceelasticity".
    expect(result.slides[0]?.body).toEqual(["price elasticity"]);
  });

  it("puts speaker notes into the slide's markdown", async () => {
    const bytes = await buildPptx({
      slides: [{ title: "Grading", notesPart: 1 }],
      notes: ["Attendance 80% required"],
    });

    const result = await extractPptx(bytes);

    expect(result.slides[0]?.markdown).toContain("Speaker notes");
    expect(result.slides[0]?.markdown).toContain("Attendance 80% required");
  });

  it("rejects a file that is not a zip", async () => {
    await expect(extractPptx(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).rejects.toThrow(
      PptxExtractionError,
    );
  });

  it("rejects a zip with no slides", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", "<w:document/>");
    const bytes = new Uint8Array(await zip.generateAsync({ type: "uint8array" }));

    await expect(extractPptx(bytes)).rejects.toMatchObject({ reason: "no-slides" });
  });
});

describe("countWords", () => {
  it("counts whitespace-separated runs and treats blank as zero", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   ")).toBe(0);
    expect(countWords("one")).toBe(1);
    expect(countWords("  one   two\nthree ")).toBe(3);
  });
});
