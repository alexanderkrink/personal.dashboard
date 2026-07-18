import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/shell/app-shell";

const { usePathname, push } = vi.hoisted(() => ({
  usePathname: vi.fn<() => string>(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname,
  useRouter: () => ({ push }),
}));

vi.mock("@/app/auth/actions", () => ({ signOut: vi.fn() }));

describe("AppShell", () => {
  beforeEach(() => {
    usePathname.mockReturnValue("/");
    push.mockReset();
    window.localStorage.clear();
  });

  function renderShell() {
    return render(
      <AppShell email="alex@example.com">
        <p>page body</p>
      </AppShell>,
    );
  }

  it("renders the page body inside a labelled main landmark with a skip link", () => {
    renderShell();

    expect(screen.getByText("page body")).toBeInTheDocument();
    expect(screen.getByRole("main")).toContainElement(screen.getByText("page body"));
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute(
      "href",
      "#main-content",
    );
  });

  it("opens and closes the command palette with ⌘K", async () => {
    const user = userEvent.setup();
    renderShell();

    expect(screen.queryByPlaceholderText("Jump to…")).not.toBeInTheDocument();

    await user.keyboard("{Meta>}k{/Meta}");
    await waitFor(() => expect(screen.getByPlaceholderText("Jump to…")).toBeInTheDocument());

    await user.keyboard("{Meta>}k{/Meta}");
    await waitFor(() => expect(screen.queryByPlaceholderText("Jump to…")).not.toBeInTheDocument());
  });

  it("opens the palette from the top-bar trigger too", async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole("button", { name: /Open the command palette/ }));
    await waitFor(() => expect(screen.getByPlaceholderText("Jump to…")).toBeInTheDocument());
  });

  it("persists the sidebar collapse state", async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    expect(window.localStorage.getItem("study-dashboard:sidebar-collapsed")).toBe("true");
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
  });
});
