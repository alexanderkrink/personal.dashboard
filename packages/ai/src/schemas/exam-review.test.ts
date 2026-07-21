import { describe, expect, it } from "vitest";
import { type ExamReview, examReviewSchema, examTopicSectionSchema } from "./exam-review";

/**
 * The one property the schema exists to guarantee: every click-through item carries
 * `topicIds`. §9 hangs the whole "click a section back to its topic page" affordance on it, so
 * a section without it is a section a student cannot navigate from.
 */

const VALID_REVIEW: ExamReview = {
  overview: "This final covers regression and elasticity, weighted toward regression.",
  sections: [
    {
      topicIds: ["topic-regression"],
      title: "Linear Regression",
      depth: "deep",
      notes: "OLS fits a line minimising squared residuals.",
      formulas: "$$\\hat{y} = \\beta_0 + \\beta_1 x$$ — the fitted line.",
      workedExample: "Given points… solve for $\\beta_1$.",
      pitfalls: "- Confusing $R^2$ with correlation.",
    },
  ],
  formulaSheet: [
    {
      topicIds: ["topic-regression"],
      name: "OLS slope",
      latex: "\\beta_1 = \\frac{\\operatorname{cov}(x,y)}{\\operatorname{var}(x)}",
      meaning: "The slope of the least-squares line.",
    },
  ],
  questionBank: [
    {
      topicIds: ["topic-regression"],
      kind: "numeric",
      question: "Compute the slope for the given data.",
      answer: "Apply the OLS slope formula: …",
    },
  ],
  weakSpots: [
    {
      topicIds: ["topic-regression"],
      issue: "Session 3 and Session 9 define residual differently.",
      suggestion: "Reconcile the two definitions before the exam.",
    },
  ],
};

describe("examReviewSchema — topicIds is mandatory on every click-through item", () => {
  it("accepts a well-formed review", () => {
    expect(examReviewSchema.safeParse(VALID_REVIEW).success).toBe(true);
  });

  // RED against making `topicIds` optional (the change that would silently break
  // click-through): a section missing it MUST fail safeParse. If `topicIds` were `.optional()`
  // this assertion would flip to a pass and the test goes red.
  it("rejects a section missing topicIds", () => {
    const { topicIds: _dropped, ...sectionWithoutIds } = VALID_REVIEW
      .sections[0] as (typeof VALID_REVIEW.sections)[number];
    const broken = { ...VALID_REVIEW, sections: [sectionWithoutIds] };
    expect(examReviewSchema.safeParse(broken).success).toBe(false);
    // And the section schema on its own rejects it too.
    expect(examTopicSectionSchema.safeParse(sectionWithoutIds).success).toBe(false);
  });

  it("accepts a section once topicIds is present", () => {
    expect(examTopicSectionSchema.safeParse(VALID_REVIEW.sections[0]).success).toBe(true);
  });

  it("rejects a formula-sheet entry, question or weak spot missing topicIds", () => {
    const noIds = <T extends { topicIds: string[] }>(item: T) => {
      const { topicIds: _drop, ...rest } = item;
      return rest;
    };
    expect(
      examReviewSchema.safeParse({
        ...VALID_REVIEW,
        formulaSheet: [
          noIds(VALID_REVIEW.formulaSheet[0] as (typeof VALID_REVIEW.formulaSheet)[number]),
        ],
      }).success,
    ).toBe(false);
    expect(
      examReviewSchema.safeParse({
        ...VALID_REVIEW,
        questionBank: [
          noIds(VALID_REVIEW.questionBank[0] as (typeof VALID_REVIEW.questionBank)[number]),
        ],
      }).success,
    ).toBe(false);
    expect(
      examReviewSchema.safeParse({
        ...VALID_REVIEW,
        weakSpots: [noIds(VALID_REVIEW.weakSpots[0] as (typeof VALID_REVIEW.weakSpots)[number])],
      }).success,
    ).toBe(false);
  });

  it("allows empty formulaSheet / questionBank / weakSpots (a course may have none)", () => {
    expect(
      examReviewSchema.safeParse({
        ...VALID_REVIEW,
        formulaSheet: [],
        questionBank: [],
        weakSpots: [],
      }).success,
    ).toBe(true);
  });
});
