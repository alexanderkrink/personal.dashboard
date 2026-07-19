// @vitest-environment node
//
// Node, not the jsdom default: this module's import graph reaches `@/env`, and t3-env
// refuses to hand a server variable to anything with a `window` on it. The functions under
// test need none of it — the env stubs below exist purely to let the module load.

import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The three pure pieces of the chunk step.
 *
 * `locatorKey` and `chunkHash` are load-bearing in a way that is invisible until it breaks:
 * `chunk_hash` is half of the partial unique indexes that close Gate 1 F4, so a hash that is
 * not stable across runs turns "a re-run is a no-op" into "a re-run duplicates every chunk
 * and re-bills every embedding". Determinism is therefore the property under test, not an
 * incidental one.
 */

const BASE_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ACCESS_CODE: "test_access_code",
  CRON_SECRET: "test_cron_secret_long_enough",
  INNGEST_SIGNING_KEY: `signkey-test-${"a".repeat(64)}`,
};

let chunkHash: typeof import("./chunk-and-embed").chunkHash;
let locatorKey: typeof import("./chunk-and-embed").locatorKey;
let topicPageSections: typeof import("./chunk-and-embed").topicPageSections;

beforeAll(async () => {
  for (const [key, value] of Object.entries(BASE_ENV)) vi.stubEnv(key, value);
  ({ chunkHash, locatorKey, topicPageSections } = await import("./chunk-and-embed"));
});

describe("locatorKey", () => {
  it("distinguishes pages, ranges and parts", () => {
    expect(locatorKey({ page: 3 })).toBe("p:3:3:0");
    expect(locatorKey({ page: 3, toPage: 5 })).toBe("p:3:5:0");
    expect(locatorKey({ page: 3, part: 2 })).toBe("p:3:3:2");
    expect(locatorKey({ page: 3, toPage: 5, part: 2 })).toBe("p:3:5:2");
  });

  it("distinguishes topic-page sections", () => {
    expect(locatorKey({ topicId: "t1", section: "summary" })).toBe("t:t1:summary:0");
    expect(locatorKey({ topicId: "t1", section: "note:intro", part: 3 })).toBe("t:t1:note:intro:3");
  });

  it("never collides a document locator with a topic locator", () => {
    expect(locatorKey({ page: 1 })).not.toBe(locatorKey({ topicId: "1", section: "1" }));
  });

  it("is insensitive to key order, which is what makes it usable as a database key", () => {
    // The reason this is hand-written rather than JSON.stringify: key order is an
    // implementation detail, and two runs that serialized differently would re-embed
    // everything and duplicate every row.
    const a: { page: number; part: number } = { page: 3, part: 1 };
    const b: { part: number; page: number } = { part: 1, page: 3 };
    expect(locatorKey(a)).toBe(locatorKey(b));
  });
});

describe("chunkHash", () => {
  const chunk = (content: string, locator = { page: 1 }) => ({
    locator,
    content,
    tokenCount: 10,
  });

  it("is a sha256 hex digest", async () => {
    expect(await chunkHash(chunk("hello"))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across runs for identical input", async () => {
    expect(await chunkHash(chunk("same text"))).toBe(await chunkHash(chunk("same text")));
  });

  it("is stable across the whitespace churn two extractions produce", async () => {
    expect(await chunkHash(chunk("Heading\n\nBody."))).toBe(
      await chunkHash(chunk("Heading\r\n\r\n\r\nBody.   \n")),
    );
  });

  it("differs when the content differs", async () => {
    expect(await chunkHash(chunk("alpha"))).not.toBe(await chunkHash(chunk("beta")));
  });

  it("differs for identical text on two different pages", async () => {
    // The whole reason the locator is in the hash: a deck that repeats a slide verbatim must
    // keep both citations rather than being deduplicated down to one by the unique index.
    expect(await chunkHash(chunk("Section divider", { page: 5 }))).not.toBe(
      await chunkHash(chunk("Section divider", { page: 12 })),
    );
  });

  it("differs between two split parts of one page", async () => {
    expect(await chunkHash(chunk("text", { page: 5, part: 1 } as never))).not.toBe(
      await chunkHash(chunk("text", { page: 5, part: 2 } as never)),
    );
  });
});

describe("topicPageSections", () => {
  it("returns nothing for a page that does not parse", () => {
    expect(topicPageSections(null)).toEqual([]);
    expect(topicPageSections("not a page")).toEqual([]);
  });

  it("returns nothing for the bare {} a fresh topic row holds", () => {
    expect(topicPageSections({})).toEqual([]);
  });

  it("derives note section ids from the block id, never from position", () => {
    // Positional ids would change every time the merger reordered the page, changing the
    // locator, changing the hash, and re-embedding every topic chunk on every merge.
    const sections = topicPageSections({
      summary: "",
      notes: [
        { id: "second-block", heading: "B", markdown: "b", sources: [] },
        { id: "first-block", heading: "A", markdown: "a", sources: [] },
      ],
      keyTerms: [],
      formulas: [],
      workedExamples: [],
      openQuestions: [],
    });

    expect(sections.map((section) => section.section)).toEqual([
      "note:second-block",
      "note:first-block",
    ]);
  });

  it("emits a summary section only when there is a summary", () => {
    const withSummary = topicPageSections({
      summary: "A real summary.",
      notes: [],
      keyTerms: [],
      formulas: [],
      workedExamples: [],
      openQuestions: [],
    });
    expect(withSummary.map((section) => section.section)).toEqual(["summary"]);

    const blank = topicPageSections({
      summary: "   ",
      notes: [],
      keyTerms: [],
      formulas: [],
      workedExamples: [],
      openQuestions: [],
    });
    expect(blank).toEqual([]);
  });

  it("rolls key terms and formulas into one section each", () => {
    const sections = topicPageSections({
      summary: "",
      notes: [],
      keyTerms: [
        { term: "Elasticity", definition: "How demand responds.", sources: [] },
        { term: "Margin", definition: "Profit per unit.", sources: [] },
      ],
      formulas: [{ name: "PED", latex: "\\frac{dQ}{dP}", explanation: "Slope.", sources: [] }],
      workedExamples: [],
      openQuestions: [],
    });

    expect(sections.map((section) => section.section)).toEqual(["keyTerms", "formulas"]);
    expect(sections[0]?.markdown).toContain("Elasticity");
    expect(sections[0]?.markdown).toContain("Margin");
    expect(sections[1]?.markdown).toContain("\\frac{dQ}{dP}");
  });

  it("keeps both halves of a worked example", () => {
    const sections = topicPageSections({
      summary: "",
      notes: [],
      keyTerms: [],
      formulas: [],
      workedExamples: [{ problem: "The problem.", solution: "The solution.", sources: [] }],
      openQuestions: [],
    });

    expect(sections[0]?.section).toBe("example:1");
    expect(sections[0]?.markdown).toContain("The problem.");
    expect(sections[0]?.markdown).toContain("The solution.");
  });

  it("does not embed open questions, which are prompts for a human rather than material", () => {
    const sections = topicPageSections({
      summary: "",
      notes: [],
      keyTerms: [],
      formulas: [],
      workedExamples: [],
      openQuestions: [
        { question: "Do these disagree?", context: "c", kind: "conflict", sources: [] },
      ],
    });

    expect(sections).toEqual([]);
  });
});
