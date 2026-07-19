import { describe, expect, it } from "vitest";
import { JOBS } from "../models";
import { SYLLABUS_COMPONENTS_SYSTEM, syllabusComponentsPrompt } from "../prompts/syllabus";
import { ASSESSMENT_KINDS, syllabusComponentsSchema } from "./syllabus";

/**
 * These tests guard the contract, not the model. Whether Sonnet actually returns the right
 * weights is checked by running it against the three real syllabi — an in-memory test
 * cannot answer that and does not pretend to.
 *
 * What it CAN answer is the set of things that would make a correct model answer land
 * wrong anyway: a kind the database will reject, a session range silently rounded to an
 * endpoint, or a prompt that forgot to include the document.
 */

const VALID = {
  courseTitle: "LEARNING TO OBSERVE, EXPERIMENT AND SURVEY",
  totalSessions: 30,
  totalSessionsEvidence: "SESSION 30 (LIVE IN-PERSON) Final Exam",
  components: [
    {
      title: "In class Midterm Exam",
      kind: "exam" as const,
      weightPercent: 30,
      sessionNumber: 19,
      sessionNote: null,
      sourceSnippet: "SESSION 19 (LIVE IN-PERSON) In class Midterm Exam",
    },
  ],
  notes: null,
};

describe("syllabusComponentsSchema", () => {
  it("accepts a well-formed extraction", () => {
    expect(syllabusComponentsSchema.parse(VALID)).toEqual(VALID);
  });

  it("permits exactly the six kinds assessments.kind allows", () => {
    // The DB check constraint is the real authority (migration 20260717161053). If these
    // drift, a perfectly good extraction dies at the insert with a constraint violation.
    expect([...ASSESSMENT_KINDS]).toEqual([
      "exam",
      "quiz",
      "project",
      "participation",
      "paper",
      "other",
    ]);
  });

  it("rejects a kind the database would refuse", () => {
    const result = syllabusComponentsSchema.safeParse({
      ...VALID,
      components: [{ ...VALID.components[0], kind: "midterm" }],
    });
    expect(result.success).toBe(false);
  });

  it("allows a null session number, because most components have none", () => {
    // Marketing Fundamentals states no inline session labels at all (PLAN.md §5.1b).
    const result = syllabusComponentsSchema.safeParse({
      ...VALID,
      components: [{ ...VALID.components[0], sessionNumber: null }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a fractional session number", () => {
    // A range averaged into 28.5 is the failure mode this catches.
    const result = syllabusComponentsSchema.safeParse({
      ...VALID,
      components: [{ ...VALID.components[0], sessionNumber: 28.5 }],
    });
    expect(result.success).toBe(false);
  });

  it("requires a non-empty source snippet — the confirm gate is useless without one", () => {
    const result = syllabusComponentsSchema.safeParse({
      ...VALID,
      components: [{ ...VALID.components[0], sourceSnippet: "" }],
    });
    expect(result.success).toBe(false);
  });

  it("allows a null total session count rather than forcing a guess", () => {
    const result = syllabusComponentsSchema.safeParse({
      ...VALID,
      totalSessions: null,
      totalSessionsEvidence: null,
    });
    expect(result.success).toBe(true);
  });

  it("describes every field, because descriptions are prompt surface", () => {
    const shape = syllabusComponentsSchema.shape;
    for (const [name, field] of Object.entries(shape)) {
      expect(field.description, `${name} has no .describe()`).toBeTruthy();
    }
    const component = shape.components.element.shape;
    for (const [name, field] of Object.entries(component)) {
      expect(field.description, `components.${name} has no .describe()`).toBeTruthy();
    }
  });
});

describe("syllabusComponentsPrompt", () => {
  it("has an id equal to its job key, per §3", () => {
    expect(syllabusComponentsPrompt.id).toBe("syllabus-components");
    expect(syllabusComponentsPrompt.id in JOBS).toBe(true);
  });

  it("starts at version 1", () => {
    expect(syllabusComponentsPrompt.version).toBe(1);
  });

  it("interpolates both the course title and the whole document", () => {
    const rendered = syllabusComponentsPrompt.render({
      courseTitle: "APPLIED BUSINESS MATHEMATICS",
      documentText: "SESSION #30 Final Exam 40%",
    });
    expect(rendered).toContain("APPLIED BUSINESS MATHEMATICS");
    expect(rendered).toContain("SESSION #30 Final Exam 40%");
  });

  it("tells the model to read past the header", () => {
    // PLAN.md §5.1b: a header-only read of LOES produced the opposite of the truth.
    const rendered = syllabusComponentsPrompt.render({ courseTitle: "x", documentText: "y" });
    expect(rendered).toMatch(/two thirds|entire text/i);
  });

  it("warns off the re-take scheme", () => {
    // Applied Business Mathematics states a third-attempt scheme (20/35/45) alongside its
    // ordinary one (40/20/20/20). Extracting the wrong one is the single highest-cost
    // mistake available on this corpus.
    const rendered = syllabusComponentsPrompt.render({ courseTitle: "x", documentText: "y" });
    expect(rendered).toMatch(/re-take|second-call|third-attempt/i);
  });

  it("ships a system message that prefers null over a guess", () => {
    expect(SYLLABUS_COMPONENTS_SYSTEM).toMatch(/null/i);
  });
});
