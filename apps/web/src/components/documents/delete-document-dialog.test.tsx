import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeleteImpact } from "@/app/(app)/documents/actions";
import { DeleteDocumentDialog } from "@/components/documents/delete-document-dialog";

/**
 * The confirmation must not lie.
 *
 * The strip removes what it can attribute and leaves what it cannot — a
 * co-authored topic's summary paragraph, and blocks whose sources name no
 * document. The whole justification for shipping a "delete everywhere" button is
 * that the dialog says both halves out loud, so these tests assert the *copy*,
 * not just the wiring: a dialog that quietly dropped the "leaves behind" section
 * would pass a render test and fail the requirement.
 */

const previewDocumentDelete = vi.hoisted(() => vi.fn());
const deleteDocument = vi.hoisted(() => vi.fn());

vi.mock("@/app/(app)/documents/actions", () => ({ previewDocumentDelete, deleteDocument }));

const NOTHING: DeleteImpact = {
  filename: "deck.pdf",
  topicsRemoved: [],
  topicsRewritten: [],
  blocksRemoved: 0,
  blocksUnattributed: 0,
  staleSummaries: 0,
  chunks: 0,
};

function open() {
  return userEvent.click(screen.getByRole("button", { name: /delete/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  previewDocumentDelete.mockResolvedValue(NOTHING);
  deleteDocument.mockResolvedValue({ ok: true });
});

describe("DeleteDocumentDialog", () => {
  it("does not delete anything just by opening", async () => {
    render(<DeleteDocumentDialog documentId="d1" filename="deck.pdf" />);
    await open();

    await waitFor(() => expect(previewDocumentDelete).toHaveBeenCalledWith({ documentId: "d1" }));
    expect(deleteDocument).not.toHaveBeenCalled();
  });

  it("names the topics that will disappear entirely", async () => {
    previewDocumentDelete.mockResolvedValue({
      ...NOTHING,
      topicsRemoved: ["Statistics Fundamentals", "Sampling Variance"],
      chunks: 29,
    } satisfies DeleteImpact);

    render(<DeleteDocumentDialog documentId="d1" filename="deck.pdf" />);
    await open();

    expect(await screen.findByText(/2 whole topics/i)).toBeInTheDocument();
    expect(screen.getByText(/Statistics Fundamentals, Sampling Variance/)).toBeInTheDocument();
    expect(screen.getByText(/29 search passages/i)).toBeInTheDocument();
  });

  it("admits to the summary it cannot strip", async () => {
    previewDocumentDelete.mockResolvedValue({
      ...NOTHING,
      topicsRewritten: ["Shared Topic"],
      blocksRemoved: 3,
      staleSummaries: 1,
    } satisfies DeleteImpact);

    render(<DeleteDocumentDialog documentId="d1" filename="deck.pdf" />);
    await open();

    expect(await screen.findByText(/This leaves behind/i)).toBeInTheDocument();
    expect(screen.getByText(/summary paragraph on 1 topic/i)).toBeInTheDocument();
    expect(screen.getByText(/may still describe what’s being removed/i)).toBeInTheDocument();
  });

  it("admits to blocks it could not attribute", async () => {
    previewDocumentDelete.mockResolvedValue({
      ...NOTHING,
      topicsRewritten: ["Shared Topic"],
      blocksRemoved: 1,
      blocksUnattributed: 2,
    } satisfies DeleteImpact);

    render(<DeleteDocumentDialog documentId="d1" filename="deck.pdf" />);
    await open();

    expect(await screen.findByText(/2 notes that don’t say which file/i)).toBeInTheDocument();
  });

  it("claims nothing it does not do when no topic is affected", async () => {
    render(<DeleteDocumentDialog documentId="d1" filename="deck.pdf" />);
    await open();

    expect(await screen.findByText(/No topic pages change/i)).toBeInTheDocument();
    expect(screen.queryByText(/This leaves behind/i)).not.toBeInTheDocument();
  });

  it("promises a clean re-upload, which is the point of the button", async () => {
    render(<DeleteDocumentDialog documentId="d1" filename="deck.pdf" />);
    await open();

    expect(await screen.findByText(/upload this file again/i)).toBeInTheDocument();
  });

  it("deletes only after the confirm, and reports the id it was given", async () => {
    previewDocumentDelete.mockResolvedValue({ ...NOTHING, topicsRemoved: ["Solo"] });
    const onDeleted = vi.fn();

    render(<DeleteDocumentDialog documentId="d1" filename="deck.pdf" onDeleted={onDeleted} />);
    await open();
    await screen.findByText(/1 whole topic/i);

    const confirm = screen.getAllByRole("button", { name: /^delete$/i }).at(-1);
    if (!confirm) throw new Error("no confirm button");
    await userEvent.click(confirm);

    await waitFor(() => expect(deleteDocument).toHaveBeenCalledWith({ documentId: "d1" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  });

  it("keeps the dialog open and shows why when the delete fails", async () => {
    deleteDocument.mockResolvedValue({ ok: false, message: "That didn’t delete. Try again." });

    render(<DeleteDocumentDialog documentId="d1" filename="deck.pdf" />);
    await open();
    await screen.findByText(/No topic pages change/i);

    const confirm = screen.getAllByRole("button", { name: /^delete$/i }).at(-1);
    if (!confirm) throw new Error("no confirm button");
    await userEvent.click(confirm);

    expect(await screen.findByText(/That didn’t delete\. Try again\./)).toBeInTheDocument();
    // Still open — a failed delete must not look like a successful one.
    expect(screen.getByText(/No topic pages change/i)).toBeInTheDocument();
  });

  it("still offers the delete when the preview could not be computed", async () => {
    // A preview failure must not strand the user on a document they cannot remove.
    previewDocumentDelete.mockResolvedValue(null);

    render(<DeleteDocumentDialog documentId="d1" filename="deck.pdf" />);
    await open();

    expect(await screen.findByText(/Couldn’t check what this affects/i)).toBeInTheDocument();
    const confirm = screen.getAllByRole("button", { name: /^delete$/i }).at(-1);
    expect(confirm).toBeEnabled();
  });
});
