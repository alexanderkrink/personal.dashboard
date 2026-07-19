import { describe, expect, it } from "vitest";
import {
  type ChunkablePage,
  type ChunkLocator,
  chunkDocument,
  chunkTopicPage,
  estimateTokens,
  MERGE_BELOW_TOKENS,
  normalizeForHash,
  SPLIT_ABOVE_TOKENS,
  structureForKind,
  TARGET_MAX_TOKENS,
} from "./chunk";

/**
 * The chunker's contract, pinned.
 *
 * Every threshold in PLAN §6 is a number in a comment until something asserts it, so each
 * one gets a test that would fail if the rule were quietly relaxed. The locator assertions
 * matter most: a chunk that cannot cite its page is a chunk that breaks "Lecture 7, slide
 * 12", which is the only reason the RAG index is worth building.
 */

/** Text of approximately `tokens` estimated tokens (4 chars ≈ 1 token). */
function text(tokens: number, word = "alpha"): string {
  const chars = tokens * 4;
  const unit = `${word} `;
  return unit
    .repeat(Math.ceil(chars / unit.length))
    .slice(0, chars)
    .trim();
}

/** `tokens` worth of text split into `count` paragraphs. */
function paragraphs(count: number, tokensEach: number, word = "beta"): string {
  return Array.from({ length: count }, (_, index) => text(tokensEach, `${word}${index}`)).join(
    "\n\n",
  );
}

function page(number: number, tokens: number, title: string | null = null): ChunkablePage {
  return { page: number, title, markdown: text(tokens, `p${number}`) };
}

function pageNumbers(locator: ChunkLocator): number[] {
  if (!("page" in locator)) return [];
  const to = locator.toPage ?? locator.page;
  return Array.from({ length: to - locator.page + 1 }, (_, index) => locator.page + index);
}

describe("estimateTokens", () => {
  it("is roughly four characters per token and never zero", () => {
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens("    ")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

describe("normalizeForHash", () => {
  it("is stable across the whitespace churn two extractions produce", () => {
    const a = "Heading\n\nBody text here.";
    const b = "Heading\r\n\r\n\r\nBody text here.   \n";
    expect(normalizeForHash(a)).toBe(normalizeForHash(b));
  });

  it("still distinguishes genuinely different content", () => {
    expect(normalizeForHash("Alpha")).not.toBe(normalizeForHash("Beta"));
  });
});

describe("structureForKind", () => {
  it("chunks readings and cases by heading and everything else per page", () => {
    expect(structureForKind("reading")).toBe("reading");
    expect(structureForKind("case")).toBe("reading");
    expect(structureForKind("slides")).toBe("slides");
    expect(structureForKind("syllabus")).toBe("slides");
    expect(structureForKind("other")).toBe("slides");
  });
});

describe("chunkDocument — units", () => {
  it("makes one chunk per slide for a deck of ordinary slides", () => {
    const chunks = chunkDocument({
      structure: "slides",
      pages: [page(1, 200), page(2, 250), page(3, 300)],
    });

    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => pageNumbers(chunk.locator))).toEqual([[1], [2], [3]]);
  });

  it("keeps the page's own heading in the chunk text", () => {
    const chunks = chunkDocument({
      structure: "slides",
      pages: [{ page: 4, title: "Price Elasticity", markdown: text(200) }],
    });

    expect(chunks[0]?.content.startsWith("Price Elasticity")).toBe(true);
  });

  it("groups a reading into heading sections rather than pages", () => {
    const chunks = chunkDocument({
      structure: "reading",
      pages: [page(1, 200), page(2, 200), page(3, 200), page(4, 200)],
      headings: [
        { text: "Chapter One", level: 1, page: 1 },
        { text: "Chapter Two", level: 1, page: 3 },
      ],
    });

    expect(chunks).toHaveLength(2);
    expect(pageNumbers(chunks[0]?.locator ?? { page: 0 })).toEqual([1, 2]);
    expect(pageNumbers(chunks[1]?.locator ?? { page: 0 })).toEqual([3, 4]);
    expect(chunks[0]?.content.startsWith("Chapter One")).toBe(true);
  });

  it("ignores headings deeper than the section level", () => {
    const chunks = chunkDocument({
      structure: "reading",
      headingLevel: 1,
      pages: [page(1, 200), page(2, 200)],
      headings: [
        { text: "Chapter One", level: 1, page: 1 },
        { text: "A subsection", level: 3, page: 2 },
      ],
    });

    expect(chunks).toHaveLength(1);
    expect(pageNumbers(chunks[0]?.locator ?? { page: 0 })).toEqual([1, 2]);
  });

  it("falls back to per-page for a reading with no usable headings, never one giant unit", () => {
    const chunks = chunkDocument({
      structure: "reading",
      pages: [page(1, 300), page(2, 300), page(3, 300)],
      headings: [],
    });

    expect(chunks).toHaveLength(3);
  });

  it("returns nothing for a document with no pages", () => {
    expect(chunkDocument({ structure: "slides", pages: [] })).toEqual([]);
  });

  it("drops pages that would chunk to nothing at all", () => {
    const chunks = chunkDocument({
      structure: "slides",
      pages: [
        { page: 1, title: "", markdown: "   " },
        { page: 2, title: "Real", markdown: text(200) },
      ],
    });

    expect(chunks.every((chunk) => chunk.content.trim() !== "")).toBe(true);
  });
});

describe("chunkDocument — merging tiny neighbours", () => {
  it("absorbs a sub-120-token slide into the one after it", () => {
    const chunks = chunkDocument({
      structure: "slides",
      pages: [page(1, 40), page(2, 300), page(3, 300)],
    });

    expect(chunks).toHaveLength(2);
    // The tiny page 1 merged forward into page 2, and the locator widened to cover both.
    expect(pageNumbers(chunks[0]?.locator ?? { page: 0 })).toEqual([1, 2]);
    expect(pageNumbers(chunks[1]?.locator ?? { page: 0 })).toEqual([3]);
  });

  it("merges a trailing tiny slide backwards, since it has no successor", () => {
    const chunks = chunkDocument({
      structure: "slides",
      pages: [page(1, 300), page(2, 300), page(3, 30)],
    });

    expect(chunks).toHaveLength(2);
    expect(pageNumbers(chunks[1]?.locator ?? { page: 0 })).toEqual([2, 3]);
  });

  it("collapses a run of tiny slides into one chunk without losing a single page", () => {
    const chunks = chunkDocument({
      structure: "slides",
      pages: [page(1, 20), page(2, 20), page(3, 20), page(4, 20), page(5, 20)],
    });

    expect(chunks).toHaveLength(1);
    expect(pageNumbers(chunks[0]?.locator ?? { page: 0 })).toEqual([1, 2, 3, 4, 5]);
  });

  it("leaves a slide at the merge threshold alone", () => {
    const chunks = chunkDocument({
      structure: "slides",
      pages: [page(1, MERGE_BELOW_TOKENS + 10), page(2, 300)],
    });

    expect(chunks).toHaveLength(2);
  });

  it("keeps both merged headings so the chunk retrieves on either", () => {
    const chunks = chunkDocument({
      structure: "slides",
      pages: [
        { page: 1, title: "Agenda", markdown: text(30) },
        { page: 2, title: "Price Elasticity", markdown: text(300) },
      ],
    });

    expect(chunks[0]?.content).toContain("Agenda");
    expect(chunks[0]?.content).toContain("Price Elasticity");
  });

  it("never leaves a lone tiny document as zero chunks", () => {
    const chunks = chunkDocument({ structure: "slides", pages: [page(1, 10)] });
    expect(chunks).toHaveLength(1);
    expect(pageNumbers(chunks[0]?.locator ?? { page: 0 })).toEqual([1]);
  });
});

describe("chunkDocument — splitting over-long units", () => {
  it("splits a page over the ceiling at paragraph boundaries", () => {
    const chunks = chunkDocument({
      structure: "slides",
      pages: [{ page: 1, title: "Long", markdown: paragraphs(10, 150) }],
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(SPLIT_ABOVE_TOKENS);
    }
  });

  it("gives every piece the parent's page and a 1-based part number", () => {
    const chunks = chunkDocument({
      structure: "slides",
      pages: [{ page: 7, title: "Long", markdown: paragraphs(10, 150) }],
    });

    expect(chunks.every((chunk) => "page" in chunk.locator && chunk.locator.page === 7)).toBe(true);
    expect(
      chunks.map((chunk) => ("page" in chunk.locator ? chunk.locator.part : undefined)),
    ).toEqual(chunks.map((_, index) => index + 1));
  });

  it("repeats the heading on every piece", () => {
    const chunks = chunkDocument({
      structure: "slides",
      pages: [{ page: 1, title: "Elasticity", markdown: paragraphs(10, 150) }],
    });

    expect(chunks.every((chunk) => chunk.content.startsWith("Elasticity"))).toBe(true);
  });

  it("overlaps consecutive pieces by carrying a whole trailing paragraph forward", () => {
    const chunks = chunkDocument({
      structure: "slides",
      pages: [{ page: 1, title: "", markdown: paragraphs(20, 60) }],
    });

    expect(chunks.length).toBeGreaterThan(1);
    const first = chunks[0];
    const second = chunks[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    const firstParagraphs = (first?.content ?? "").split("\n\n");
    const secondParagraphs = (second?.content ?? "").split("\n\n");
    const shared = firstParagraphs.filter((part) => secondParagraphs.includes(part));
    expect(shared.length).toBeGreaterThan(0);
  });

  it("cuts a single enormous paragraph at sentence boundaries rather than mid-word", () => {
    const sentence = `${text(60, "gamma")}. `;
    const chunks = chunkDocument({
      structure: "slides",
      pages: [{ page: 1, title: "", markdown: sentence.repeat(30).trim() }],
    });

    expect(chunks.length).toBeGreaterThan(1);
    // No piece ends mid-word: each ends on punctuation or a complete token.
    for (const chunk of chunks) {
      expect(chunk.content.trim().endsWith("gamma")).toBe(false);
    }
  });

  it("emits an unsplittable run whole rather than truncating a user's content", () => {
    // No paragraph breaks and no sentence punctuation at all.
    const chunks = chunkDocument({
      structure: "slides",
      pages: [{ page: 1, title: "", markdown: text(2000, "delta") }],
    });

    const rejoined = chunks.map((chunk) => chunk.content).join(" ");
    expect(rejoined.length).toBeGreaterThanOrEqual(2000 * 4 * 0.9);
  });

  it("splits a unit that only became over-long through merging", () => {
    // Five tiny slides plus one large one: merge produces an over-ceiling unit that the
    // split phase must still take apart. This is why merge runs before split.
    const chunks = chunkDocument({
      structure: "slides",
      pages: [
        { page: 1, title: "", markdown: text(30) },
        { page: 2, title: "", markdown: paragraphs(8, 150) },
      ],
    });

    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(SPLIT_ABOVE_TOKENS);
    }
  });
});

describe("chunkDocument — locator preservation", () => {
  it("accounts for every input page across the emitted chunks", () => {
    const pages = Array.from({ length: 24 }, (_, index) =>
      page(index + 1, index % 5 === 0 ? 40 : 260),
    );
    const chunks = chunkDocument({ structure: "slides", pages });

    const covered = new Set(chunks.flatMap((chunk) => pageNumbers(chunk.locator)));
    for (let n = 1; n <= 24; n += 1) expect(covered.has(n)).toBe(true);
  });

  it("never emits a chunk without a locator", () => {
    const chunks = chunkDocument({
      structure: "reading",
      pages: Array.from({ length: 12 }, (_, index) => page(index + 1, 200)),
      headings: [{ text: "Only heading", level: 1, page: 1 }],
    });

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect("page" in chunk.locator ? chunk.locator.page : 0).toBeGreaterThanOrEqual(1);
    }
  });

  it("is deterministic — the same input chunks identically twice", () => {
    const input = {
      structure: "slides" as const,
      pages: [page(1, 40), page(2, 900), page(3, 300)],
    };
    expect(chunkDocument(input)).toEqual(chunkDocument(input));
  });

  it("sorts out-of-order pages before chunking", () => {
    const chunks = chunkDocument({
      structure: "slides",
      pages: [page(3, 300), page(1, 300), page(2, 300)],
    });

    expect(chunks.map((chunk) => pageNumbers(chunk.locator))).toEqual([[1], [2], [3]]);
  });
});

describe("chunkTopicPage", () => {
  it("emits one chunk per section with a topic locator", () => {
    const chunks = chunkTopicPage({
      topicId: "topic-1",
      sections: [
        { section: "summary", heading: "Summary", markdown: text(200) },
        { section: "note:intro", heading: "Introduction", markdown: text(300) },
      ],
    });

    expect(chunks).toHaveLength(2);
    expect(
      chunks.map((chunk) => ("topicId" in chunk.locator ? chunk.locator.section : null)),
    ).toEqual(["summary", "note:intro"]);
    expect(
      chunks.every((chunk) => "topicId" in chunk.locator && chunk.locator.topicId === "topic-1"),
    ).toBe(true);
  });

  it("does NOT merge tiny sections, because a merged locator would mis-cite one of them", () => {
    const chunks = chunkTopicPage({
      topicId: "topic-1",
      sections: [
        { section: "summary", heading: "Summary", markdown: text(20) },
        { section: "keyTerms", heading: "Key terms", markdown: text(20) },
      ],
    });

    expect(chunks).toHaveLength(2);
  });

  it("still splits an over-long section and keeps the section in every piece's locator", () => {
    const chunks = chunkTopicPage({
      topicId: "topic-1",
      sections: [{ section: "note:body", heading: "Body", markdown: paragraphs(12, 150) }],
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.every((chunk) => "topicId" in chunk.locator && chunk.locator.section === "note:body"),
    ).toBe(true);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(SPLIT_ABOVE_TOKENS);
    }
  });

  it("skips sections with nothing in them", () => {
    const chunks = chunkTopicPage({
      topicId: "topic-1",
      sections: [
        { section: "summary", heading: "", markdown: "   " },
        { section: "note:a", heading: "A", markdown: text(200) },
      ],
    });

    expect(chunks).toHaveLength(1);
  });
});

describe("the target band", () => {
  it("keeps ordinary slide content inside the ceiling", () => {
    const chunks = chunkDocument({
      structure: "slides",
      pages: Array.from({ length: 30 }, (_, index) => page(index + 1, 350)),
    });

    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeGreaterThan(0);
      expect(chunk.tokenCount).toBeLessThanOrEqual(SPLIT_ABOVE_TOKENS);
    }
  });

  it("aims split pieces at the 500-token target rather than the 800 ceiling", () => {
    const chunks = chunkDocument({
      structure: "slides",
      pages: [{ page: 1, title: "", markdown: paragraphs(20, 100) }],
    });

    // Every piece but possibly the last should be near the target, not the ceiling.
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(TARGET_MAX_TOKENS + 120);
    }
  });
});
