import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HistoryDrawer, type HistoryRevision } from "@/components/topic-page/history-drawer";

const revertTopicRevision = vi.hoisted(() => vi.fn());
const setExamWeightOverride = vi.hoisted(() => vi.fn());

vi.mock("@/app/(app)/courses/[id]/topics/[slug]/actions", () => ({
  revertTopicRevision,
  setExamWeightOverride,
}));

/**
 * The drawer's tests assert **copy**, not only wiring.
 *
 * The empty state is the whole reason this component needed care: `topic_revisions` really
 * is empty for every topic still on its first version, and a drawer that rendered nothing
 * there would pass a render test while committing the exact silent-nothing failure Wave 5
 * exists to kill. So the assertion is on the sentence, and removing the sentence turns this
 * red.
 */

const CURRENT = {
  summary: "Now.",
  notes: [
    { id: "a", heading: "Kept", markdown: "same", sources: [] },
    { id: "c", heading: "Added later", markdown: "new", sources: [] },
  ],
};

const BEFORE = {
  summary: "Then.",
  notes: [
    { id: "a", heading: "Kept", markdown: "same", sources: [] },
    { id: "b", heading: "Dropped", markdown: "gone", sources: [] },
  ],
};

const revision: HistoryRevision = {
  id: "11111111-1111-4111-8111-111111111111",
  revision: 1,
  headline: "Lecture 7 expanded this page",
  changeSummary: "Added the CLT block.",
  source: "merge",
  needsReview: false,
  reviewNotes: [],
  createdAt: "2026-07-20T10:00:00Z",
  promptId: "topic-merge",
  promptVersion: 2,
  model: "claude-sonnet-5",
  page: BEFORE,
};

function open() {
  return userEvent.click(screen.getByRole("button", { name: /history/i }));
}

describe("HistoryDrawer — no history recorded", () => {
  it("says the first version has no snapshot instead of rendering an empty list", async () => {
    render(
      <HistoryDrawer
        courseId="c"
        currentPage={CURRENT}
        currentRevision={1}
        revisions={[]}
        slug="s"
        topicId="t"
      />,
    );
    await open();

    expect(screen.getByTestId("no-history")).toBeInTheDocument();
    expect(screen.getByText(/No history was recorded for this page/i)).toBeInTheDocument();
    expect(
      screen.getByText(/There is nothing to compare against and nothing to revert to/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("revision-row")).toBeNull();
  });
});

describe("HistoryDrawer — with revisions", () => {
  it("labels a revision by its source and shows the prompt stamp", async () => {
    render(
      <HistoryDrawer
        courseId="c"
        currentPage={CURRENT}
        currentRevision={2}
        revisions={[revision]}
        slug="s"
        topicId="t"
      />,
    );
    await open();

    expect(screen.getByText("Lecture 7 expanded this page")).toBeInTheDocument();
    expect(screen.getByText(/topic-merge@v2/)).toBeInTheDocument();
    expect(screen.queryByTestId("no-history")).toBeNull();
  });

  it("counts the diff against the live page, losses included", async () => {
    render(
      <HistoryDrawer
        courseId="c"
        currentPage={CURRENT}
        currentRevision={2}
        revisions={[revision]}
        slug="s"
        topicId="t"
      />,
    );
    await open();

    expect(screen.getByText(/1 added · 1 removed/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /view diff/i }));
    const diff = screen.getByTestId("diff");
    expect(diff.textContent).toContain("Dropped");
    expect(diff.textContent).toContain("removed");
    expect(diff.textContent).toContain("Added later");
  });

  it("marks a flagged revision", async () => {
    render(
      <HistoryDrawer
        courseId="c"
        currentPage={CURRENT}
        currentRevision={2}
        revisions={[{ ...revision, needsReview: true, headline: "⚠ Flagged — review this change" }]}
        slug="s"
        topicId="t"
      />,
    );
    await open();

    expect(screen.getByTestId("revision-row").getAttribute("data-needs-review")).toBe("true");
    expect(screen.getByText(/Flagged — review this change/)).toBeInTheDocument();
  });

  it("says WHY a revision was flagged, not just that it was", async () => {
    render(
      <HistoryDrawer
        courseId="c"
        currentPage={CURRENT}
        currentRevision={2}
        revisions={[
          {
            ...revision,
            needsReview: true,
            reviewNotes: [
              "This page states 6 formulas the source never displayed.",
              "The key term “Chi-square distribution” appears nowhere in the source.",
            ],
          },
        ]}
        slug="s"
        topicId="t"
      />,
    );
    await open();

    const notes = screen.getByTestId("review-notes");
    expect(notes.textContent).toContain("6 formulas the source never displayed");
    expect(notes.textContent).toContain("appears nowhere in the source");
  });

  it("renders no review-notes block when a revision carries none", async () => {
    render(
      <HistoryDrawer
        courseId="c"
        currentPage={CURRENT}
        currentRevision={2}
        revisions={[revision]}
        slug="s"
        topicId="t"
      />,
    );
    await open();

    expect(screen.queryByTestId("review-notes")).toBeNull();
  });

  it("sends the revert through the server action", async () => {
    revertTopicRevision.mockResolvedValue({ ok: true, message: "Reverted to revision 1." });
    render(
      <HistoryDrawer
        courseId="course-1"
        currentPage={CURRENT}
        currentRevision={2}
        revisions={[revision]}
        slug="sampling"
        topicId="topic-1"
      />,
    );
    await open();
    await userEvent.click(screen.getByRole("button", { name: /revert to this/i }));

    expect(revertTopicRevision).toHaveBeenCalledWith({
      topicId: "topic-1",
      revisionId: revision.id,
      courseId: "course-1",
      slug: "sampling",
    });
  });
});
