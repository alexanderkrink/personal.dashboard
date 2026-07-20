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

// The quick-add dialog hangs off the shell (CAL-3: "⌘K from anywhere"), and its action
// modules transitively import `@/env` — which throws in a test process, same reason
// `@/app/auth/actions` is mocked above. The actions themselves are covered by
// `quick-add-parse.test.ts`; here they only need to exist.
vi.mock("@/app/(app)/calendar/quick-add-parse", () => ({
  parseQuickAddUtterance: vi.fn(async () => ({ status: "idle" })),
  listQuickAddCourses: vi.fn(async () => []),
}));
vi.mock("@/app/(app)/calendar/item-actions", () => ({
  createQuickAddItem: vi.fn(async () => ({ status: "idle" })),
}));

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

    expect(screen.queryByPlaceholderText("Type a command or jump to…")).not.toBeInTheDocument();

    await user.keyboard("{Meta>}k{/Meta}");
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Type a command or jump to…")).toBeInTheDocument(),
    );

    await user.keyboard("{Meta>}k{/Meta}");
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Type a command or jump to…")).not.toBeInTheDocument(),
    );
  });

  it("opens the palette from the top-bar trigger too", async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole("button", { name: /Open the command palette/ }));
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Type a command or jump to…")).toBeInTheDocument(),
    );
  });

  it("reaches natural-language quick-add from the palette — ⌘K from anywhere (§6)", async () => {
    const user = userEvent.setup();
    renderShell();

    await user.keyboard("{Meta>}k{/Meta}");
    await user.click(await screen.findByText("Add to calendar…"));

    // The palette hands off to the quick-add dialog: NL input on top, the
    // structured form — the §6 floor — beneath it, all before any navigation.
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Add to calendar" })).toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Say it in one line")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add to calendar/ })).toBeInTheDocument();
  });

  it("persists the sidebar collapse state", async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    expect(window.localStorage.getItem("study-dashboard:sidebar-collapsed")).toBe("true");
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
  });
});
