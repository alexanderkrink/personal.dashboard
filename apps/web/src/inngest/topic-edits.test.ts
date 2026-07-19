import type { StoredTopicPage } from "@study/ai";
import { EMPTY_TOPIC_PAGE } from "@study/ai";
import { describe, expect, it } from "vitest";
import { applyEdits, slugFor, type TopicPageEdit } from "./topic-edits";

/**
 * `applyEdits` is the function that makes "the deep-review audit never overwrites anything"
 * a property of the code rather than a promise in a comment, so it gets tested like one.
 *
 * The idempotency cases matter as much as the additive ones. Both callers run inside
 * `process-document`, which retries a step up to three times, so an edit function that
 * appended on every attempt would give a student three copies of the same block and three
 * History entries that changed nothing.
 */

const page = (overrides: Partial<StoredTopicPage> = {}): StoredTopicPage => ({
  ...EMPTY_TOPIC_PAGE,
  ...overrides,
});

const noteEdit = (id: string, markdown = "Some new material."): TopicPageEdit => ({
  kind: "note",
  id,
  heading: "A heading",
  markdown,
  documentId: "11111111-1111-1111-1111-111111111111",
  page: 4,
});

const questionEdit = (question: string, kind: "gap" | "conflict" = "gap"): TopicPageEdit => ({
  kind: "open-question",
  question: { question, context: "Because of something.", kind, sources: [] },
});

describe("applyEdits — additive only", () => {
  it("appends a note block without touching the existing ones", () => {
    const before = page({
      notes: [{ id: "existing", heading: "Existing", markdown: "Original text.", sources: [] }],
    });

    const after = applyEdits(before, [noteEdit("brand-new")]);

    expect(after.notes).toHaveLength(2);
    expect(after.notes[0]).toEqual(before.notes[0]);
    expect(after.notes[1]?.id).toBe("brand-new");
  });

  it("carries the source citation onto the appended block", () => {
    const after = applyEdits(page(), [noteEdit("cited")]);

    expect(after.notes[0]?.sources).toEqual([
      { documentId: "11111111-1111-1111-1111-111111111111", page: 4 },
    ]);
  });

  it("appends an open question without touching existing ones", () => {
    const before = page({
      openQuestions: [
        { question: "An old question?", context: "Old context.", kind: "conflict", sources: [] },
      ],
    });

    const after = applyEdits(before, [questionEdit("A new question?")]);

    expect(after.openQuestions).toHaveLength(2);
    expect(after.openQuestions[0]).toEqual(before.openQuestions[0]);
  });

  it("NEVER removes or rewrites an existing block, whatever the edit says", () => {
    const before = page({
      notes: [{ id: "keep-me", heading: "Keep", markdown: "Do not touch.", sources: [] }],
      keyTerms: [{ term: "Elasticity", definition: "A definition.", sources: [] }],
      formulas: [{ name: "F", latex: "x", explanation: "e", sources: [] }],
      workedExamples: [{ problem: "p", solution: "s", sources: [] }],
      summary: "The original summary.",
    });

    const after = applyEdits(before, [
      // Same id as an existing block — the closest thing to an overwrite this API allows.
      noteEdit("keep-me", "REPLACEMENT TEXT"),
      questionEdit("Something new?"),
    ]);

    expect(after.notes).toEqual(before.notes);
    expect(after.notes[0]?.markdown).toBe("Do not touch.");
    expect(after.keyTerms).toEqual(before.keyTerms);
    expect(after.formulas).toEqual(before.formulas);
    expect(after.workedExamples).toEqual(before.workedExamples);
    expect(after.summary).toBe("The original summary.");
  });
});

describe("applyEdits — idempotency under retry", () => {
  it("returns the identical object when every edit is a duplicate", () => {
    const before = page({
      notes: [{ id: "already-here", heading: "H", markdown: "M", sources: [] }],
    });

    const after = applyEdits(before, [noteEdit("already-here")]);

    // Reference equality is the contract the caller relies on to skip the write entirely.
    expect(after).toBe(before);
  });

  it("does not duplicate a note across repeated applications", () => {
    const once = applyEdits(page(), [noteEdit("stable-id")]);
    const twice = applyEdits(once, [noteEdit("stable-id")]);
    const thrice = applyEdits(twice, [noteEdit("stable-id")]);

    expect(thrice.notes).toHaveLength(1);
    expect(thrice).toBe(once);
  });

  it("deduplicates an open question on its text, since two callers can spot one gap", () => {
    const once = applyEdits(page(), [questionEdit("Is this covered?")]);
    const twice = applyEdits(once, [questionEdit("Is this covered?")]);

    expect(twice.openQuestions).toHaveLength(1);
    expect(twice).toBe(once);
  });

  it("ignores surrounding whitespace when deduplicating a question", () => {
    const once = applyEdits(page(), [questionEdit("Is this covered?")]);
    const twice = applyEdits(once, [questionEdit("  Is this covered?  ")]);

    expect(twice.openQuestions).toHaveLength(1);
  });

  it("applies the new parts of a mixed batch and drops the duplicates", () => {
    const before = applyEdits(page(), [noteEdit("first"), questionEdit("Q1?")]);
    const after = applyEdits(before, [
      noteEdit("first"),
      noteEdit("second"),
      questionEdit("Q1?"),
      questionEdit("Q2?"),
    ]);

    expect(after.notes.map((note) => note.id)).toEqual(["first", "second"]);
    expect(after.openQuestions.map((question) => question.question)).toEqual(["Q1?", "Q2?"]);
  });

  it("is a no-op for an empty edit list", () => {
    const before = page({ notes: [{ id: "a", heading: "h", markdown: "m", sources: [] }] });
    expect(applyEdits(before, [])).toBe(before);
  });
});

describe("applyEdits — open question kinds", () => {
  it("records a conflict as a conflict, which is what stops it being overwritten", () => {
    const after = applyEdits(page(), [questionEdit("Do these disagree?", "conflict")]);
    expect(after.openQuestions[0]?.kind).toBe("conflict");
  });

  it("records a syllabus gap as a gap", () => {
    const after = applyEdits(page(), [questionEdit("Is this taught?", "gap")]);
    expect(after.openQuestions[0]?.kind).toBe("gap");
  });
});

describe("slugFor", () => {
  it("slugifies a title", () => {
    expect(slugFor("Price Elasticity of Demand", new Set())).toBe("price-elasticity-of-demand");
  });

  it("strips accents rather than dropping the characters", () => {
    expect(slugFor("Función de Producción", new Set())).toBe("funcion-de-produccion");
  });

  it("uniquifies against slugs the course already uses", () => {
    expect(slugFor("Elasticity", new Set(["elasticity"]))).toBe("elasticity-2");
    expect(slugFor("Elasticity", new Set(["elasticity", "elasticity-2"]))).toBe("elasticity-3");
  });

  it("falls back to a usable slug for a title with no slug-able characters", () => {
    expect(slugFor("!!!", new Set())).toBe("topic");
  });

  it("bounds the slug length", () => {
    expect(slugFor("a".repeat(200), new Set()).length).toBeLessThanOrEqual(60);
  });
});
