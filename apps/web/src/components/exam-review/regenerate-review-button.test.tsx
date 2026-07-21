import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RegenerateReviewButton } from "@/components/exam-review/regenerate-review-button";

/**
 * The button's in-flight / requested guard — the cheap first line against a double-billed Opus
 * run. Once a request is accepted the trigger stays disabled ("Requested"); while one is in
 * flight the confirm button is disabled, so neither a second click nor a click that races the
 * first can fire the action twice.
 */

const mocks = vi.hoisted(() => ({ requestExamReview: vi.fn() }));

vi.mock("@/app/(app)/courses/[id]/reviews/actions", () => ({
  requestExamReview: mocks.requestExamReview,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

const TRIGGER = "Regenerate";
const CONFIRM = "Regenerate (~$0.50–1.50)";

beforeEach(() => {
  mocks.requestExamReview.mockReset();
});

async function openAndFindConfirm() {
  fireEvent.click(screen.getByRole("button", { name: TRIGGER }));
  return screen.findByRole("button", { name: CONFIRM });
}

describe("RegenerateReviewButton", () => {
  it("calls the action once with the course id and a requestId, then disables the trigger", async () => {
    mocks.requestExamReview.mockResolvedValue({ ok: true });
    render(<RegenerateReviewButton courseId="course-x" label={TRIGGER} />);

    fireEvent.click(await openAndFindConfirm());

    await waitFor(() => expect(mocks.requestExamReview).toHaveBeenCalledTimes(1));
    expect(mocks.requestExamReview).toHaveBeenCalledWith({
      courseId: "course-x",
      requestId: expect.any(String),
    });
    // The trigger is now the permanent "Requested" state.
    await waitFor(() => expect(screen.getByRole("button", { name: "Requested" })).toBeDisabled());
  });

  // RED against removing `disabled={pending || requested}` on the confirm button: a second click
  // while the first request is still in flight would fire the action a SECOND time — a second
  // ~$0.50–1.50 Opus run. The controlled promise holds the first call pending.
  it("does not fire a second action while one is in flight", async () => {
    let resolve: ((value: { ok: true }) => void) | undefined;
    mocks.requestExamReview.mockReturnValue(
      new Promise<{ ok: true }>((r) => {
        resolve = r;
      }),
    );
    render(<RegenerateReviewButton courseId="course-x" label={TRIGGER} />);

    const confirm = await openAndFindConfirm();
    fireEvent.click(confirm);

    // Once in flight, the confirm button disables — a second click must be a no-op.
    await waitFor(() => expect(confirm).toBeDisabled());
    fireEvent.click(confirm);

    resolve?.({ ok: true });
    await waitFor(() => expect(mocks.requestExamReview).toHaveBeenCalledTimes(1));
  });

  it("surfaces a deferred result without marking the button as requested", async () => {
    mocks.requestExamReview.mockResolvedValue({ ok: false, deferred: true, message: "paused" });
    render(<RegenerateReviewButton courseId="course-x" label={TRIGGER} />);

    fireEvent.click(await openAndFindConfirm());

    await waitFor(() => expect(mocks.requestExamReview).toHaveBeenCalledTimes(1));
    // Not "Requested": a deferred request did not enqueue anything, so the user may retry.
    await waitFor(() => expect(screen.getByRole("button", { name: TRIGGER })).not.toBeDisabled());
  });
});
