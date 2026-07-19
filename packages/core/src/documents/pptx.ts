/**
 * PPTX text extraction (PLAN "Document & Notes Pipeline" §4.2, v1 path).
 *
 * A `.pptx` is a zip of XML. This module inflates it and reads the two part
 * families that carry a lecture's words:
 *
 *   - `ppt/slides/slide{N}.xml` — shape text and tables, i.e. what is projected;
 *   - `ppt/notesSlides/notesSlide{N}.xml` — the speaker notes.
 *
 * **Speaker notes are frequently the richest content in a lecture deck and are
 * exactly what naive converters drop.** A slide reading "Price elasticity" over a
 * chart is nearly contentless; its notes paragraph is the lecture. So notes are
 * a first-class output here, not an appendix.
 *
 * ## 🔴 notesSlide{N} is NOT the notes for slide{N}
 *
 * Measured against the real corpus (`s01-basics.pptx`, 2026-07-19): the deck has
 * 28 slides and only 13 notesSlides, and `ppt/slides/_rels/slide3.xml.rels`
 * points at `../notesSlides/notesSlide1.xml`. Pairing by index would have
 * attached slide 3's lecture notes to slide 1 and then run out, silently
 * mis-filing every note in the deck. Notes are therefore resolved **through the
 * per-slide relationship part**, which is the only authoritative mapping.
 *
 * The same applies to slide *order*: file numbering is allocation order, not
 * presentation order. The running order lives in `ppt/presentation.xml`'s
 * `<p:sldId>` list, resolved through `ppt/_rels/presentation.xml.rels`. It
 * usually coincides with the file numbers, which is precisely why a deck that
 * has been reordered in PowerPoint would break an index-based reader in a way no
 * test on a tidy fixture would catch.
 *
 * ## Purity
 *
 * `packages/core` has no `@types/node` and this module keeps it that way:
 * `jszip` and `fast-xml-parser` are pure JS with no Node builtins, verified by
 * typecheck (an `import "node:fs"` in this directory still fails to resolve).
 * Nothing here does I/O — bytes in, structure out. The caller downloads.
 */

import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";

/**
 * The words-per-slide threshold that routes a deck to the visual path (§4.2).
 *
 * PLAN measured the real corpus on 2026-07-18 and the split is clean: four of
 * five Marketing decks land at 22–39, all three Micro decks at 60–84. There is
 * no cluster near the line, which is what makes a single scalar threshold
 * defensible rather than a fudge.
 */
export const VISUAL_DECK_WORDS_PER_SLIDE = 40;

/**
 * Ceiling on inflated text, in characters (~40 MB).
 *
 * `zip.ts` deliberately refuses to decompress anything and says so: its guard is
 * over the archive's *declared* sizes, which an adversarial archive can lie
 * about. This module is the one that actually inflates, so per its note it caps
 * its own output. A real deck is a few hundred KB of text; anything approaching
 * this is not a lecture.
 */
export const MAX_PPTX_TEXT_CHARS = 40_000_000;

export interface PptxSlide {
  /** 1-based **presentation** order, not the slide part's file number. */
  readonly number: number;
  /** The part name this came from, e.g. `slide12`. Kept for provenance. */
  readonly part: string;
  /** Text of the title placeholder, when the slide has one. */
  readonly title: string | null;
  /** Body paragraphs, in reading order, title excluded. */
  readonly body: readonly string[];
  /** Tables, row-major. Each cell is already flattened to a single string. */
  readonly tables: readonly (readonly (readonly string[])[])[];
  /** Speaker notes, resolved through the slide's relationship part. */
  readonly notes: string | null;
  /** Words in the slide body (title + body + tables). **Excludes notes** — see below. */
  readonly slideWords: number;
  /** Words in the speaker notes. */
  readonly notesWords: number;
  /** The slide rendered as markdown, notes included under a `> Notes:` block. */
  readonly markdown: string;
}

export interface PptxExtraction {
  readonly slides: readonly PptxSlide[];
  readonly slideCount: number;
  /** How many slides actually carried notes. Diagnostic for the fidelity note. */
  readonly slidesWithNotes: number;
  /** Total words across slide bodies. Excludes notes. */
  readonly slideWords: number;
  readonly notesWords: number;
  /**
   * `slideWords / slideCount` — the §4.2 routing statistic.
   *
   * ⚠ **Notes are deliberately excluded from this number.** PLAN's measured table
   * was computed "from `ppt/slides/slide*.xml`", so including notes here would
   * silently re-scale the threshold that table calibrated: a visual deck with
   * thorough speaker notes would score as text-rich and skip the visual path,
   * which is the exact failure the measurement exists to prevent. Notes are
   * extracted, kept and sent to the model — they just do not get a vote on
   * whether the slides need to be *seen*.
   */
  readonly wordsPerSlide: number;
  /** Whole deck as markdown, slides in presentation order. */
  readonly markdown: string;
}

/** Whether this deck's text yield puts it on the visual path (§4.2). */
export function isVisualDeck(extraction: PptxExtraction): boolean {
  return extraction.wordsPerSlide < VISUAL_DECK_WORDS_PER_SLIDE;
}

export type PptxFailureReason =
  | "not-a-zip"
  | "no-slides"
  /** Inflated text exceeded {@link MAX_PPTX_TEXT_CHARS}. */
  | "too-much-text";

export class PptxExtractionError extends Error {
  constructor(
    readonly reason: PptxFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "PptxExtractionError";
  }
}

/** Counts words the way the §4.2 measurement does: whitespace-separated runs. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

// ── XML plumbing ──────────────────────────────────────────────────────────────
//
// `fast-xml-parser` hands back plain objects whose shape depends on the
// document (a lone child is an object, several are an array), so everything
// below walks `unknown` defensively rather than asserting a shape. Slide XML is
// deeply irregular in the wild — grouped shapes, SmartArt, text in tables — and
// a reader that assumes a tidy tree drops content silently, which is the one
// failure mode this whole module exists to avoid.

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Text runs carry meaningful leading/trailing spaces between formatting
  // changes ("price " + "elasticity"); trimming them welds words together.
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every value stored under `key`, at any depth, in document order. */
function collect(node: unknown, key: string): unknown[] {
  const found: unknown[] = [];
  const walk = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const item of current) walk(item);
      return;
    }
    if (!isRecord(current)) return;
    for (const [name, value] of Object.entries(current)) {
      if (name === key) {
        if (Array.isArray(value)) found.push(...value);
        else found.push(value);
      }
      walk(value);
    }
  };
  walk(node);
  return found;
}

/** The concatenated text of one `<a:p>` paragraph: every `<a:t>` beneath it. */
function paragraphText(paragraph: unknown): string {
  return collect(paragraph, "a:t")
    .map((run) => (typeof run === "string" ? run : typeof run === "number" ? String(run) : ""))
    .join("")
    .replace(/ /g, " ")
    .trim();
}

/** Non-empty paragraphs beneath a node, in order. */
function paragraphsOf(node: unknown): string[] {
  return collect(node, "a:p")
    .map(paragraphText)
    .filter((text) => text !== "");
}

/** A shape's placeholder type (`title`, `ctrTitle`, `body`, …), when it declares one. */
function placeholderType(shape: unknown): string | null {
  for (const ph of collect(shape, "p:ph")) {
    if (isRecord(ph)) {
      const type = ph["@_type"];
      if (typeof type === "string") return type;
    }
  }
  return null;
}

function isTitlePlaceholder(type: string | null): boolean {
  return type === "title" || type === "ctrTitle";
}

/** Tables under a node, row-major, each cell flattened to one string. */
function tablesOf(node: unknown): string[][][] {
  const tables: string[][][] = [];
  for (const table of collect(node, "a:tbl")) {
    const rows: string[][] = [];
    for (const row of collect(table, "a:tr")) {
      const cells = collect(row, "a:tc").map((cell) => paragraphsOf(cell).join(" ").trim());
      if (cells.some((cell) => cell !== "")) rows.push(cells);
    }
    if (rows.length > 0) tables.push(rows);
  }
  return tables;
}

function tableToMarkdown(rows: readonly (readonly string[])[]): string {
  const [header, ...rest] = rows;
  if (header === undefined) return "";
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell) => cell.replace(/\|/g, "\\|").replace(/\s+/g, " ")).join(" | ")} |`;
  return [line(header), `| ${header.map(() => "---").join(" | ")} |`, ...rest.map(line)].join("\n");
}

// ── Package structure ─────────────────────────────────────────────────────────

/** `Id → Target` from a `.rels` part. */
function relationships(xml: string): Map<string, string> {
  const parsed = parser.parse(xml);
  const map = new Map<string, string>();
  for (const relationship of collect(parsed, "Relationship")) {
    if (!isRecord(relationship)) continue;
    const id = relationship["@_Id"];
    const target = relationship["@_Target"];
    if (typeof id === "string" && typeof target === "string") map.set(id, target);
  }
  return map;
}

/** Resolves a relationship target against the part that declared it. */
function resolveTarget(fromPart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const base = fromPart.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") base.pop();
    else base.push(segment);
  }
  return base.join("/");
}

/**
 * Slide parts in **presentation order**.
 *
 * Falls back to numeric part order only when `presentation.xml` cannot be read —
 * a fallback that is honest about being one, rather than the primary path
 * dressed up as correct.
 */
function slideOrder(
  presentationXml: string | null,
  presentationRels: Map<string, string>,
): string[] {
  if (presentationXml !== null) {
    const parsed = parser.parse(presentationXml);
    const ordered: string[] = [];
    for (const slideId of collect(parsed, "p:sldId")) {
      if (!isRecord(slideId)) continue;
      const relationshipId = slideId["@_r:id"];
      if (typeof relationshipId !== "string") continue;
      const target = presentationRels.get(relationshipId);
      if (target !== undefined) ordered.push(resolveTarget("ppt/presentation.xml", target));
    }
    if (ordered.length > 0) return ordered;
  }
  return [];
}

const SLIDE_PART = /^ppt\/slides\/slide(\d+)\.xml$/;

/**
 * Extracts a `.pptx`'s text.
 *
 * Async because inflation is: `jszip` decompresses each part on demand, which is
 * also what keeps the memory ceiling per-part rather than whole-archive.
 */
export async function extractPptx(bytes: Uint8Array): Promise<PptxExtraction> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (error) {
    throw new PptxExtractionError(
      "not-a-zip",
      `Could not read the PowerPoint package: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }

  const readPart = async (path: string): Promise<string | null> => {
    const file = zip.file(path);
    return file === null ? null : await file.async("string");
  };

  const presentationRelsXml = await readPart("ppt/_rels/presentation.xml.rels");
  const presentationRels =
    presentationRelsXml === null ? new Map<string, string>() : relationships(presentationRelsXml);
  const ordered = slideOrder(await readPart("ppt/presentation.xml"), presentationRels);

  // Everything that IS a slide part, numerically sorted — both the fallback
  // order and the safety net for a slide the presentation list forgot.
  const byFileNumber = Object.keys(zip.files)
    .filter((name) => SLIDE_PART.test(name))
    .sort((a, b) => {
      const numberOf = (name: string): number => Number(SLIDE_PART.exec(name)?.[1] ?? 0);
      return numberOf(a) - numberOf(b);
    });

  // Presentation order first, then anything it omitted. A slide missing from
  // `<p:sldId>` is hidden or orphaned, and dropping it would be a silent loss —
  // the exact category of failure `skipped` exists to make visible.
  const parts = [...ordered.filter((part) => byFileNumber.includes(part))];
  for (const part of byFileNumber) if (!parts.includes(part)) parts.push(part);

  if (parts.length === 0) {
    throw new PptxExtractionError(
      "no-slides",
      "This PowerPoint file has no slides in it — `ppt/slides/` is empty.",
    );
  }

  let inflatedChars = 0;
  const budgeted = (text: string): string => {
    inflatedChars += text.length;
    if (inflatedChars > MAX_PPTX_TEXT_CHARS) {
      throw new PptxExtractionError(
        "too-much-text",
        "This PowerPoint file expands to far more text than a lecture deck should. It may be corrupted.",
      );
    }
    return text;
  };

  const slides: PptxSlide[] = [];

  for (const [index, part] of parts.entries()) {
    const xml = await readPart(part);
    if (xml === null) continue;
    const parsed = parser.parse(budgeted(xml));

    const spTree = collect(parsed, "p:spTree")[0] ?? parsed;

    let title: string | null = null;
    const body: string[] = [];
    for (const shape of collect(spTree, "p:sp")) {
      const paragraphs = paragraphsOf(shape);
      if (paragraphs.length === 0) continue;
      if (title === null && isTitlePlaceholder(placeholderType(shape))) {
        const [first, ...rest] = paragraphs;
        title = first ?? null;
        body.push(...rest);
        continue;
      }
      body.push(...paragraphs);
    }
    const tables = tablesOf(spTree);

    // ── Notes, via the slide's own relationship part ──────────────────────
    const slideRelsXml = await readPart(
      part.replace(/^ppt\/slides\//, "ppt/slides/_rels/") + ".rels",
    );
    let notes: string | null = null;
    if (slideRelsXml !== null) {
      for (const target of relationships(budgeted(slideRelsXml)).values()) {
        if (!target.includes("notesSlide")) continue;
        const notesXml = await readPart(resolveTarget(part, target));
        if (notesXml === null) continue;
        const notesParsed = parser.parse(budgeted(notesXml));
        // A notesSlide embeds a thumbnail of the slide, whose placeholder
        // repeats the slide's own text. Only the `body` placeholder is the
        // lecturer's writing; taking every paragraph would double-count the
        // slide text into the notes and inflate the notes word count.
        const notesShapes = collect(notesParsed, "p:sp").filter(
          (shape) => placeholderType(shape) === "body",
        );
        const paragraphs = notesShapes.flatMap((shape) => paragraphsOf(shape));
        const text = paragraphs.join("\n").trim();
        if (text !== "") notes = text;
        break;
      }
    }

    const slideText = [title ?? "", ...body, ...tables.flat(2)].join(" ");
    const markdownParts = [
      `## Slide ${index + 1}${title === null ? "" : `: ${title}`}`,
      ...body.map((line) => `- ${line}`),
      ...tables.map(tableToMarkdown).filter((table) => table !== ""),
      ...(notes === null
        ? []
        : ["", "> **Speaker notes:**", ...notes.split("\n").map((line) => `> ${line}`)]),
    ];

    slides.push({
      number: index + 1,
      part: part.replace(/^ppt\/slides\//, "").replace(/\.xml$/, ""),
      title,
      body,
      tables,
      notes,
      slideWords: countWords(slideText),
      notesWords: notes === null ? 0 : countWords(notes),
      markdown: markdownParts.join("\n"),
    });
  }

  const slideWords = slides.reduce((sum, slide) => sum + slide.slideWords, 0);
  const notesWords = slides.reduce((sum, slide) => sum + slide.notesWords, 0);

  return {
    slides,
    slideCount: slides.length,
    slidesWithNotes: slides.filter((slide) => slide.notes !== null).length,
    slideWords,
    notesWords,
    wordsPerSlide: slides.length === 0 ? 0 : slideWords / slides.length,
    markdown: slides.map((slide) => slide.markdown).join("\n\n"),
  };
}
