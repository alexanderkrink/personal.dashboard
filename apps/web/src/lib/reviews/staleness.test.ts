import { describe, expect, it } from "vitest";
import { countChangedTopics, type DatedDocument, materialsThrough } from "@/lib/reviews/staleness";

const SNAPSHOT = [
  { topicId: "t1", revision: 3 },
  { topicId: "t2", revision: 1 },
];

describe("countChangedTopics", () => {
  it("counts a topic whose revision moved forward", () => {
    const changed = countChangedTopics(
      SNAPSHOT,
      new Map([
        ["t1", 4],
        ["t2", 1],
      ]),
    );
    expect(changed).toBe(1);
  });

  it("counts a topic that disappeared", () => {
    expect(countChangedTopics(SNAPSHOT, new Map([["t1", 3]]))).toBe(1);
  });

  // RED against counting NEW topics as changes (e.g. iterating `current` instead of the
  // snapshot): a review has not decayed because the course grew. A brand-new t3 must add 0.
  it("does NOT count a new topic the review never covered", () => {
    const changed = countChangedTopics(
      SNAPSHOT,
      new Map([
        ["t1", 3],
        ["t2", 1],
        ["t3", 5],
      ]),
    );
    expect(changed).toBe(0);
  });

  it("is 0 when nothing moved", () => {
    expect(
      countChangedTopics(
        SNAPSHOT,
        new Map([
          ["t1", 3],
          ["t2", 1],
        ]),
      ),
    ).toBe(0);
  });

  it("returns 0 for an unreadable snapshot rather than inventing a count", () => {
    expect(countChangedTopics(null, new Map([["t1", 9]]))).toBe(0);
  });
});

describe("materialsThrough", () => {
  const doc = (overrides: Partial<DatedDocument>): DatedDocument => ({
    sessionLabel: null,
    createdAt: "2026-01-01T00:00:00Z",
    filename: "deck.pdf",
    ...overrides,
  });

  it("uses the newest document's session label", () => {
    const label = materialsThrough([
      doc({ sessionLabel: "Lecture 3", createdAt: "2026-01-01T00:00:00Z" }),
      doc({ sessionLabel: "Lecture 9", createdAt: "2026-03-01T00:00:00Z" }),
    ]);
    expect(label).toBe("Lecture 9");
  });

  it("falls back to the filename when the newest document has no label", () => {
    const label = materialsThrough([
      doc({ sessionLabel: "Lecture 3", createdAt: "2026-01-01T00:00:00Z" }),
      doc({ sessionLabel: null, filename: "week12.pdf", createdAt: "2026-03-01T00:00:00Z" }),
    ]);
    expect(label).toBe("week12.pdf");
  });

  it("is null when there are no documents", () => {
    expect(materialsThrough([])).toBeNull();
  });
});
