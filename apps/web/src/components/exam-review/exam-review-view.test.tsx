import type { ExamReview } from "@study/ai";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExamReviewView, type ReviewTopicRef } from "@/components/exam-review/exam-review-view";

/**
 * §9's click-through affordance ("Every item carries topic ids for click-through"), asserted
 * at the render layer — the only place the "id → link" resolution actually happens.
 */

const REVIEW: ExamReview = {
  overview: "A short overview.",
  sections: [
    {
      topicIds: ["topic-known"],
      title: "Linear Regression",
      depth: "deep",
      notes: "Some notes.",
      formulas: "",
      workedExample: null,
      pitfalls: "",
    },
  ],
  formulaSheet: [
    {
      topicIds: ["topic-ghost"], // deliberately NOT in the topics map
      name: "Mystery Formula",
      latex: "x^2",
      meaning: "It squares x.",
    },
  ],
  questionBank: [],
  weakSpots: [],
};

const TOPICS = new Map<string, ReviewTopicRef>([
  ["topic-known", { slug: "linear-regression", title: "Linear Regression" }],
]);

describe("ExamReviewView — click-through", () => {
  it("turns a resolvable topic id into a link to its topic page", () => {
    render(<ExamReviewView review={REVIEW} courseId="course-x" topics={TOPICS} />);
    const link = screen.getByRole("link", { name: "Linear Regression" });
    expect(link).toHaveAttribute("href", "/courses/course-x/topics/linear-regression");
  });

  // RED against dropping the "unknown id → render nothing" guard (e.g. `topics.get(id)!.slug`):
  // an id not in the map must degrade to no chip, never crash and never render a broken link.
  it("renders no chip for a topic id it cannot resolve, and does not crash", () => {
    render(<ExamReviewView review={REVIEW} courseId="course-x" topics={TOPICS} />);
    // The formula itself still renders…
    expect(screen.getByText("Mystery Formula")).toBeInTheDocument();
    // …but the unresolved id produces no link.
    expect(screen.queryByRole("link", { name: "topic-ghost" })).toBeNull();
    // Exactly one link on the page — the resolvable section topic.
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("renders the overview", () => {
    render(<ExamReviewView review={REVIEW} courseId="course-x" topics={TOPICS} />);
    expect(screen.getByTestId("review-overview")).toHaveTextContent("A short overview.");
  });
});
