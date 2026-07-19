/**
 * Structure-aware chunking (PLAN "Document & Notes Pipeline" §6, M1 item 5e).
 *
 * > **Chunking (pure functions in `packages/core`):** structure-aware, not fixed-window.
 * > Units: slide/page for decks, heading sections for readings. Target 300–500 tokens;
 * > merge tiny neighbors below ~120 tokens; split over-800-token units at paragraph
 * > boundaries with ~15% overlap. Every chunk keeps its `locator`.
 *
 * This module is that paragraph, executable. It is pure — no I/O, no `process.env`, no Node
 * built-ins, no clock, no randomness — which is what makes the whole of it unit-testable and
 * what makes a re-run produce byte-identical chunks. That last property is not cosmetic:
 * `document_chunks.chunk_hash` is the embedding-reuse key, so a chunker that split
 * differently on two runs would re-bill every chunk of every re-processed document.
 *
 * ## The three rules, and the order they run in
 *
 * 1. **Unit** — a page/slide for a deck, a heading section for a reading. Never a
 *    fixed character window: a window boundary lands mid-sentence and mid-table, and the
 *    resulting chunk retrieves badly *and* cites badly.
 * 2. **Merge** — a unit under {@link MERGE_BELOW_TOKENS} is absorbed into its neighbour.
 *    A title slide, an agenda and a "any questions?" slide are each a chunk that will match
 *    every query weakly and no query well; three of them merged is one chunk that at least
 *    describes the deck's shape.
 * 3. **Split** — a unit over {@link SPLIT_ABOVE_TOKENS} is cut at paragraph boundaries with
 *    {@link OVERLAP_RATIO} of carry-over. Overlap exists because the sentence that answers a
 *    question is frequently the one straddling the cut; without it that answer is in neither
 *    chunk in a retrievable form.
 *
 * Merge runs before split deliberately. Merging can produce an over-large unit (five tiny
 * slides plus one big one), and splitting first would mean that unit is never re-examined.
 * Splitting last means every emitted chunk is inside the ceiling, whatever route it took.
 *
 * ## Locators survive every transformation
 *
 * A chunk that cannot say where it came from cannot be cited, and "Lecture 7, slide 12" is
 * the entire reason the RAG surface is worth building. So a merge widens the locator to a
 * page *range* rather than picking a winner, and a split carries the parent's locator onto
 * every piece with a `part` discriminator. There is no path through this module that drops
 * a locator, and {@link chunkDocument} is tested for exactly that.
 */

/** Target lower bound (PLAN §6). Informational — nothing forces a chunk up to it. */
export const TARGET_MIN_TOKENS = 300;
/** Target upper bound. A split aims for pieces at or just under this. */
export const TARGET_MAX_TOKENS = 500;
/** Below this a unit is "tiny" and gets absorbed into a neighbour. */
export const MERGE_BELOW_TOKENS = 120;
/** Above this a unit is split. The hard ceiling on an emitted chunk, barring one exception. */
export const SPLIT_ABOVE_TOKENS = 800;
/** ~15% of a split piece is carried into the next one. */
export const OVERLAP_RATIO = 0.15;

/**
 * Where a chunk came from — `document_chunks.locator`, which is `jsonb not null`.
 *
 * Two shapes, matching the table's `source` discriminator:
 * - `source = 'document'` → a page (or page range, after a merge) of a document;
 * - `source = 'topic_page'` → a section of a synthesized topic page.
 *
 * `part` appears only on a piece of a split unit and is 1-based. It is what keeps two
 * pieces of one over-long page distinguishable in the uniqueness key — without it, a page
 * that split into three would collide with itself on `(document_id, chunk_hash)` only when
 * the pieces happened to be identical, and be silently indistinguishable in a citation
 * otherwise.
 */
export type ChunkLocator =
  | {
      readonly page: number;
      /** Present only when a merge widened the locator across pages. */
      readonly toPage?: number;
      readonly part?: number;
    }
  | {
      readonly topicId: string;
      readonly section: string;
      readonly part?: number;
    };

/** One unit before merging and splitting: a page, a slide, or a heading section. */
export interface ChunkUnit {
  readonly locator: ChunkLocator;
  /** Heading for the unit, rendered into the chunk text. Empty string when there is none. */
  readonly title: string;
  readonly markdown: string;
}

export interface Chunk {
  readonly locator: ChunkLocator;
  /** The text that gets embedded, heading included. */
  readonly content: string;
  /** Estimated tokens, by {@link estimateTokens}. Feeds `document_chunks.token_count`. */
  readonly tokenCount: number;
}

/**
 * Tokens, estimated rather than tokenized.
 *
 * Four characters per token is the standard rough figure for English prose, and this is the
 * right place to be rough: nothing downstream is a hard provider limit — the thresholds are
 * ours, the value lands in an informational `token_count` column, and Voyage bills on its
 * own count rather than on this one. A real tokenizer would be a large dependency in a
 * package whose defining property is that it runs anywhere.
 *
 * `Math.max(1, …)` because `document_chunks.token_count` carries `check (token_count > 0)`
 * and a whitespace-only chunk must not be the thing that fails an insert.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.trim().length / 4));
}

/**
 * The text a chunk's hash is taken over.
 *
 * Normalized so that whitespace-only churn between two extractions of the same document —
 * a trailing space, `\r\n` versus `\n`, a doubled blank line — does not change the hash and
 * therefore does not re-bill the embedding. Hashing itself is deliberately *not* here:
 * SHA-256 means Web Crypto, which is async, and an async pure function would make the whole
 * chunker async for the sake of one digest. The caller hashes this string.
 */
export function normalizeForHash(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Renders a unit to the text that is embedded. The heading is part of the chunk on purpose:
 * it is often the only place the topic word appears, and a body without it retrieves worse. */
function renderUnit(title: string, markdown: string): string {
  const heading = title.trim();
  const body = markdown.trim();
  if (heading === "") return body;
  if (body === "") return heading;
  return `${heading}\n\n${body}`;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Building units                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

/** The extractor's per-page output, structurally. Mirrors `extractedPageSchema`. */
export interface ChunkablePage {
  readonly page: number;
  readonly title?: string | null;
  readonly markdown: string;
}

/** The extractor's heading list, structurally. Mirrors `extractedHeadingSchema`. */
export interface ChunkableHeading {
  readonly text: string;
  readonly level: number;
  readonly page: number;
}

/**
 * Which structure the document has, and therefore what a unit is.
 *
 * `slides` → one unit per page/slide. `reading` → one unit per heading section, falling
 * back to per-page when the document has no usable headings. The distinction is PLAN's
 * ("slide/page for decks, heading sections for readings") and it comes from
 * `documents.kind`, which the uploader sets — not from anything inferred here.
 */
export type ChunkStructure = "slides" | "reading";

export interface ChunkDocumentInput {
  readonly pages: readonly ChunkablePage[];
  readonly headings?: readonly ChunkableHeading[];
  readonly structure: ChunkStructure;
  /** Headings at or above this level open a section. Deeper ones stay inside one. */
  readonly headingLevel?: number;
}

const DEFAULT_HEADING_LEVEL = 2;

/**
 * `documents.kind` → the structure to chunk it as.
 *
 * A total function over the five `kind` values the check constraint permits, so adding a
 * sixth is a decision rather than a default. `case` and `reading` are prose and chunk by
 * heading; `slides` chunks per slide; `syllabus` and `other` are short and heterogeneous,
 * and per-page is the choice that cannot smear two unrelated sections together.
 */
export function structureForKind(kind: string): ChunkStructure {
  return kind === "reading" || kind === "case" ? "reading" : "slides";
}

function buildUnits(input: ChunkDocumentInput): ChunkUnit[] {
  const pages = [...input.pages]
    .filter((page) => Number.isFinite(page.page))
    .sort((a, b) => a.page - b.page);

  if (pages.length === 0) return [];

  if (input.structure === "slides") {
    return pages.map((page) => ({
      locator: { page: page.page },
      title: (page.title ?? "").trim(),
      markdown: page.markdown,
    }));
  }

  // ── reading: group consecutive pages under the heading that opened them ────
  const headingLevel = input.headingLevel ?? DEFAULT_HEADING_LEVEL;
  const boundaries = new Map<number, string>();
  for (const heading of input.headings ?? []) {
    if (heading.level > headingLevel) continue;
    // First heading on a page wins, so a page carrying both an H1 and an H2 opens one
    // section named by the more significant of the two.
    if (!boundaries.has(heading.page)) boundaries.set(heading.page, heading.text.trim());
  }

  // No usable headings is a real and common input (a scanned reading, a plain PDF). Falling
  // back to per-page beats returning one unit per document: the split rule below would cut
  // that unit into fixed-size pieces, which is precisely the fixed-window chunking PLAN
  // rejects, arrived at through the branch meant to prevent it.
  if (boundaries.size === 0) {
    return pages.map((page) => ({
      locator: { page: page.page },
      title: (page.title ?? "").trim(),
      markdown: page.markdown,
    }));
  }

  const units: ChunkUnit[] = [];
  let current: ChunkablePage[] = [];
  let currentTitle = "";

  const flush = (): void => {
    const first = current[0];
    const last = current[current.length - 1];
    if (first === undefined || last === undefined) return;
    units.push({
      locator:
        first.page === last.page ? { page: first.page } : { page: first.page, toPage: last.page },
      title: currentTitle,
      markdown: current
        .map((page) => page.markdown.trim())
        .filter((text) => text !== "")
        .join("\n\n"),
    });
    current = [];
  };

  for (const page of pages) {
    const boundary = boundaries.get(page.page);
    if (boundary !== undefined && current.length > 0) flush();
    if (current.length === 0) currentTitle = boundary ?? (page.title ?? "").trim();
    current.push(page);
  }
  flush();

  return units;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Merging tiny neighbours                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

/** Two locators, combined. Only page locators can widen; a topic section keeps its own. */
function mergeLocators(a: ChunkLocator, b: ChunkLocator): ChunkLocator {
  if ("page" in a && "page" in b) {
    const from = Math.min(a.page, b.page);
    const to = Math.max(a.toPage ?? a.page, b.toPage ?? b.page);
    return from === to ? { page: from } : { page: from, toPage: to };
  }
  // Mixed or topic-page locators: the first one wins. Reachable only if a caller mixes
  // sources into one call, which nothing here does — but a merge must still be total.
  return a;
}

function mergeUnits(a: ChunkUnit, b: ChunkUnit): ChunkUnit {
  const titles = [a.title.trim(), b.title.trim()].filter((title) => title !== "");
  return {
    locator: mergeLocators(a.locator, b.locator),
    // Both titles are kept, joined, rather than one being dropped: a merged "Agenda" +
    // "Price Elasticity" chunk should retrieve on both words. `Array.from(new Set(…))`
    // because a deck often repeats one running title across several tiny slides.
    title: Array.from(new Set(titles)).join(" · "),
    markdown: [a.markdown.trim(), b.markdown.trim()].filter((text) => text !== "").join("\n\n"),
  };
}

/**
 * Absorbs every unit under {@link MERGE_BELOW_TOKENS} into a neighbour.
 *
 * Forward-preferring: a tiny unit joins the one *after* it, because a heading slide belongs
 * with the content it introduces rather than with the content it followed. The last unit has
 * no successor and joins backwards instead.
 *
 * Terminates because every merge reduces the unit count by one, and a pass that merges
 * nothing exits. The `SPLIT_ABOVE_TOKENS` guard stops a merge that would produce a unit the
 * split rule then has to take apart again — with one deliberate exception: a tiny unit whose
 * only possible partner is already over the ceiling is merged anyway, because leaving a
 * 30-token orphan chunk in the index is worse than a slightly over-long one that the split
 * rule will handle in the next phase.
 */
function mergeTinyUnits(units: readonly ChunkUnit[]): ChunkUnit[] {
  if (units.length <= 1) return [...units];

  let working = [...units];
  let merged = true;

  while (merged && working.length > 1) {
    merged = false;
    for (let i = 0; i < working.length; i += 1) {
      const unit = working[i];
      if (unit === undefined) continue;
      if (estimateTokens(renderUnit(unit.title, unit.markdown)) >= MERGE_BELOW_TOKENS) continue;

      const forward = working[i + 1];
      const backward = i > 0 ? working[i - 1] : undefined;

      // Prefer the neighbour that keeps the result inside the ceiling; prefer forward when
      // both do, and fall back to whichever exists when neither does.
      const fits = (other: ChunkUnit | undefined): boolean => {
        if (other === undefined) return false;
        const candidate = mergeUnits(unit, other);
        return (
          estimateTokens(renderUnit(candidate.title, candidate.markdown)) <= SPLIT_ABOVE_TOKENS
        );
      };

      const target = fits(forward)
        ? "forward"
        : fits(backward)
          ? "backward"
          : forward !== undefined
            ? "forward"
            : backward !== undefined
              ? "backward"
              : "none";

      if (target === "forward" && forward !== undefined) {
        working = [...working.slice(0, i), mergeUnits(unit, forward), ...working.slice(i + 2)];
        merged = true;
        break;
      }
      if (target === "backward" && backward !== undefined) {
        working = [...working.slice(0, i - 1), mergeUnits(backward, unit), ...working.slice(i + 1)];
        merged = true;
        break;
      }
    }
  }

  return working;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Splitting over-long units                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/** Paragraphs, in order, with blank-line separators collapsed. Never empty for non-empty text. */
function paragraphsOf(text: string): string[] {
  const parts = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return parts.length === 0 ? [text.trim()].filter((part) => part !== "") : parts;
}

/**
 * A paragraph too long to be a chunk on its own, cut at sentence boundaries.
 *
 * The escape hatch for a wall-of-text page with no blank lines — a scanned reading, a
 * badly-converted deck. Sentences rather than characters because a chunk cut mid-word
 * embeds as noise. If even one "sentence" is over the ceiling (no punctuation at all), it
 * is emitted whole: truncating a user's content to satisfy our own threshold would be a
 * silent loss, which is the one thing this whole subsystem exists to prevent.
 */
function splitLongParagraph(paragraph: string): string[] {
  if (estimateTokens(paragraph) <= SPLIT_ABOVE_TOKENS) return [paragraph];

  const sentences = paragraph.match(/[^.!?]+[.!?]+[\])'"`’”]*\s*|[^.!?]+$/g) ?? [paragraph];
  const pieces: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    const candidate = current === "" ? sentence : `${current}${sentence}`;
    if (current !== "" && estimateTokens(candidate) > TARGET_MAX_TOKENS) {
      pieces.push(current.trim());
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current.trim() !== "") pieces.push(current.trim());
  return pieces.filter((piece) => piece !== "");
}

/**
 * Splits one over-long unit into pieces at paragraph boundaries, with ~15% overlap.
 *
 * The overlap is taken as **whole trailing paragraphs** of the piece just emitted, not as a
 * character count: a fractional paragraph is exactly the mid-sentence cut the paragraph
 * boundary was chosen to avoid, so the overlap respects the same boundary the split does.
 * That makes the realised overlap approximate — {@link OVERLAP_RATIO} is a target, and a
 * unit of two enormous paragraphs gets none, which is correct rather than a shortfall.
 */
function splitUnit(unit: ChunkUnit): Chunk[] {
  const rendered = renderUnit(unit.title, unit.markdown);
  if (estimateTokens(rendered) <= SPLIT_ABOVE_TOKENS) {
    return [{ locator: unit.locator, content: rendered, tokenCount: estimateTokens(rendered) }];
  }

  const paragraphs = paragraphsOf(unit.markdown).flatMap(splitLongParagraph);
  const overlapBudget = Math.round(TARGET_MAX_TOKENS * OVERLAP_RATIO);

  const pieces: string[][] = [];
  let current: string[] = [];

  const currentTokens = (): number => estimateTokens(current.join("\n\n"));

  for (const paragraph of paragraphs) {
    if (current.length > 0 && currentTokens() + estimateTokens(paragraph) > TARGET_MAX_TOKENS) {
      pieces.push(current);
      // Carry back whole trailing paragraphs until the overlap budget is spent.
      const carried: string[] = [];
      for (let i = current.length - 1; i >= 0; i -= 1) {
        const candidate = current[i];
        if (candidate === undefined) continue;
        if (estimateTokens([candidate, ...carried].join("\n\n")) > overlapBudget) break;
        carried.unshift(candidate);
      }
      current = [...carried];
    }
    current.push(paragraph);
  }
  if (current.length > 0) pieces.push(current);

  return pieces.map((paragraphList, index) => {
    // Every piece repeats the unit's heading. It is a handful of tokens and it is what keeps
    // piece 3 of 5 retrievable — a mid-page fragment with no heading has lost the one word
    // that says what it is about.
    const content = renderUnit(unit.title, paragraphList.join("\n\n"));
    return {
      locator: { ...unit.locator, part: index + 1 },
      content,
      tokenCount: estimateTokens(content),
    };
  });
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The entry points                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Chunks a document's extracted pages (`source = 'document'`).
 *
 * Deterministic and total: the same input always produces the same chunks, and every chunk
 * carries a locator that names a page of the input.
 */
export function chunkDocument(input: ChunkDocumentInput): Chunk[] {
  const units = buildUnits(input);
  const merged = mergeTinyUnits(units);
  return merged.flatMap(splitUnit).filter((chunk) => normalizeForHash(chunk.content) !== "");
}

/**
 * One section of a synthesized topic page, ready to chunk (`source = 'topic_page'`).
 *
 * PLAN §6: "Topic-page sections themselves are also embedded (into `document_chunks` with a
 * synthetic locator) so search covers the synthesized notes, not just raw sources." Without
 * this, a search for a term the merger *wrote* — a summary sentence, a distilled definition
 * — finds only the raw slide it was distilled from, which is the worse of the two answers.
 */
export interface TopicPageSection {
  /** Stable within the topic. Becomes `locator.section`, so it must not be positional. */
  readonly section: string;
  readonly heading: string;
  readonly markdown: string;
}

/**
 * Chunks a topic page's sections.
 *
 * The same merge and split rules, because a topic page has the same two failure modes: a
 * one-line `keyTerms` section is a tiny chunk, and a well-fed topic's notes block can run
 * well past the ceiling. The only difference is the locator, which names the topic and the
 * section rather than a page.
 */
export function chunkTopicPage(input: {
  readonly topicId: string;
  readonly sections: readonly TopicPageSection[];
}): Chunk[] {
  const units: ChunkUnit[] = input.sections
    .filter((section) => section.markdown.trim() !== "" || section.heading.trim() !== "")
    .map((section) => ({
      locator: { topicId: input.topicId, section: section.section },
      title: section.heading.trim(),
      markdown: section.markdown,
    }));

  // Deliberately NOT merged across sections: a merge would have to pick one section's
  // locator and thereby mis-cite the other, and unlike pages there is no "range" that means
  // anything. A tiny section is simply a small chunk.
  return units.flatMap(splitUnit).filter((chunk) => normalizeForHash(chunk.content) !== "");
}
