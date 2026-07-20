import { describe, expect, it } from "vitest";
import { diffCountLabel, diffTopicPages } from "./diff";

const intro = { id: "intro", heading: "Intro", markdown: "first", sources: [] };
const clt = { id: "clt", heading: "CLT", markdown: "second", sources: [] };

const base = {
  summary: "What sampling distributions are.",
  notes: [intro, clt],
  keyTerms: [{ term: "Parameter", definition: "population value", sources: [] }],
};

describe("diffTopicPages", () => {
  it("reports an identical page as identical rather than as zero changes", () => {
    const diff = diffTopicPages(base, base);
    expect(diff.identical).toBe(true);
    expect(diffCountLabel(diff)).toBeNull();
  });

  it("names a removed block", () => {
    const after = { ...base, notes: [intro] };
    const diff = diffTopicPages(base, after);
    expect(diff.removed).toBe(1);
    expect(diff.entries[0]?.status).toBe("removed");
    expect(diff.entries[0]?.label).toBe("CLT");
    expect(diff.entries[0]?.after).toBeNull();
  });

  it("puts losses first, ahead of additions and unchanged rows", () => {
    const after = {
      ...base,
      notes: [intro, { id: "se", heading: "Standard error", markdown: "new", sources: [] }],
    };
    const diff = diffTopicPages(base, after);
    // Two unchanged rows: the surviving note and the untouched key term.
    expect(diff.entries.map((e) => e.status)).toEqual([
      "removed",
      "added",
      "unchanged",
      "unchanged",
    ]);
  });

  it("treats a reworded block as changed, not as deleted plus added", () => {
    const after = {
      ...base,
      notes: [intro, { ...clt, markdown: "second, rewritten" }],
    };
    const diff = diffTopicPages(base, after);
    expect(diff.changed).toBe(1);
    expect(diff.removed).toBe(0);
    expect(diff.added).toBe(0);
    expect(diff.entries[0]?.before).toBe("second");
    expect(diff.entries[0]?.after).toBe("second, rewritten");
  });

  it("notices a rewritten summary even when no block moved", () => {
    const diff = diffTopicPages(base, { ...base, summary: "Rewritten." });
    expect(diff.summaryChanged).toBe(true);
    expect(diff.identical).toBe(false);
    expect(diffCountLabel(diff)).toBe("summary rewritten");
  });

  it("tolerates the bare {} a topic holds before its first merge", () => {
    const diff = diffTopicPages({}, base);
    expect(diff.added).toBe(3);
    expect(diff.removed).toBe(0);
    expect(diffCountLabel(diff)).toBe("3 added");
  });
});
