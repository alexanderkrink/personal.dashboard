import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UploadDialog } from "@/components/documents/upload-dialog";

/**
 * REGRESSION: an upload error must not be terminal.
 *
 * The submit button used to carry `disabled={… || error !== null}`, which reads
 * as ordinary defensiveness and is not. `chooseFile` is the only other place
 * that clears `error`, and it runs from the file input's `change` event — which
 * a browser does NOT fire when the user re-picks the same file. So once any
 * error landed, the button stayed disabled for the file that caused it, and the
 * only escape was closing the dialog.
 *
 * That is worst for the failure this flow is built around: a dropped transfer
 * lands in the catch with the file still selected, exactly when
 * `findPreviousUploads()` would resume from the last TUS checkpoint. Closing
 * the dialog discards that and restarts at zero, which gives up the single
 * property TUS was chosen for.
 */

const checkDuplicate = vi.hoisted(() => vi.fn());
const registerUpload = vi.hoisted(() => vi.fn());
const uploadToStorage = vi.hoisted(() => vi.fn());
const hashFile = vi.hoisted(() => vi.fn());

vi.mock("@/app/(app)/documents/actions", () => ({ checkDuplicate, registerUpload }));

// Mocked WHOLE, never `importActual`: the real module imports `@/env`, whose
// t3-env schema throws on the missing NEXT_PUBLIC_* vars under vitest. The only
// export the component needs besides the two functions is the error class.
vi.mock("@/lib/documents/upload", () => ({
  uploadToStorage,
  hashFile,
  UploadCancelledError: class UploadCancelledError extends Error {
    constructor() {
      super("Upload cancelled.");
      this.name = "UploadCancelledError";
    }
  },
}));

function pdf(name = "deck.pdf", bytes = 1024) {
  return new File([new Uint8Array(bytes)], name, { type: "application/pdf" });
}

async function openWithFile(user: ReturnType<typeof userEvent.setup>, file: File) {
  render(<UploadDialog courseId="c1" userId="u1" onUploaded={() => {}} />);
  await user.click(screen.getByRole("button", { name: "Upload" }));
  const input = await screen.findByLabelText("File");
  await user.upload(input, file);
  return screen.getByRole("button", { name: "Upload" });
}

describe("UploadDialog error recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hashFile.mockResolvedValue("a".repeat(64));
    checkDuplicate.mockResolvedValue({ duplicate: false });
    uploadToStorage.mockResolvedValue("u1/c1/d1/deck.pdf");
  });

  it("leaves the button clickable after a failed transfer, so the same file can resume", async () => {
    const user = userEvent.setup();
    uploadToStorage.mockRejectedValueOnce(new Error("Network connection lost."));
    const submit = await openWithFile(user, pdf());

    await user.click(submit);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

    // The whole point: still clickable, with the file still selected.
    expect(submit).toBeEnabled();

    // And a second click really does retry rather than being swallowed.
    await user.click(submit);
    await waitFor(() => expect(uploadToStorage).toHaveBeenCalledTimes(2));
  });

  it("still refuses an oversized file without transferring anything", async () => {
    const user = userEvent.setup();
    // 51 MB — over MAX_DOCUMENT_BYTES.
    const submit = await openWithFile(user, pdf("huge.pdf", 51 * 1024 * 1024));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    await user.click(submit);

    // Re-shows the message and uploads nothing: the size guard survives the fix.
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(uploadToStorage).not.toHaveBeenCalled();
    expect(hashFile).not.toHaveBeenCalled();
  });
});
