import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppSidebar } from "@/components/shell/app-sidebar";

const usePathname = vi.hoisted(() => vi.fn<() => string>());

vi.mock("next/navigation", () => ({ usePathname }));

// The sign-out form posts to a Server Action, which has no meaning in jsdom.
vi.mock("@/app/auth/actions", () => ({ signOut: vi.fn() }));

function renderSidebar(pathname: string, collapsed = false) {
  usePathname.mockReturnValue(pathname);
  return render(
    <AppSidebar collapsed={collapsed} onToggle={() => {}} email="alex@example.com" ready />,
  );
}

function navLink(name: string) {
  return within(screen.getByRole("navigation", { name: "Primary" })).getByRole("link", { name });
}

describe("AppSidebar active route", () => {
  beforeEach(() => {
    usePathname.mockReset();
  });

  it("marks only the matching item as the current page", () => {
    renderSidebar("/courses");

    expect(navLink("Courses")).toHaveAttribute("aria-current", "page");
    for (const label of ["Dashboard", "Calendar", "Documents"]) {
      expect(navLink(label)).not.toHaveAttribute("aria-current");
    }
  });

  it("gives the active item the accent-subtle tint and 500 weight", () => {
    renderSidebar("/calendar");

    const active = navLink("Calendar");
    expect(active).toHaveClass("bg-accent-subtle");
    expect(active).toHaveClass("font-medium");

    const inactive = navLink("Documents");
    expect(inactive).not.toHaveClass("bg-accent-subtle");
    expect(inactive).toHaveClass("font-normal");
  });

  it("renders the active item's icon at fill weight and everything else at regular", () => {
    renderSidebar("/documents");

    // Phosphor puts the weight on the rendered <svg>'s child geometry, so assert
    // on the icon element the link actually contains.
    const activeIcon = navLink("Documents").querySelector("svg");
    const inactiveIcon = navLink("Dashboard").querySelector("svg");
    expect(activeIcon).not.toBeNull();
    expect(inactiveIcon).not.toBeNull();
    // A filled Phosphor glyph draws a single solid path; the regular weight
    // draws stroked geometry, so the two markups differ.
    expect(activeIcon?.innerHTML).not.toEqual(inactiveIcon?.innerHTML);
  });

  /**
   * The focus treatment is a single utility (`focus-ring` in globals.css) so
   * that PLAN's "2px --ring + 2px offset, always visible" cannot drift per
   * component. The sidebar used to carry its own `FOCUS_RING_SIDEBAR` variant,
   * which existed only to re-declare a ring-offset colour; an `outline` with a
   * transparent offset is correct on every surface, so there is one again.
   */
  it("gives every focusable in the rail the one focus treatment", () => {
    renderSidebar("/");

    for (const label of ["Dashboard", "Courses", "Calendar", "Documents"]) {
      expect(navLink(label)).toHaveClass("focus-ring");
    }
    expect(screen.getByRole("button", { name: "Sign out" })).toHaveClass("focus-ring");
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toHaveClass("focus-ring");
  });

  it("treats `/` as an exact match so a subroute does not light the Dashboard", () => {
    renderSidebar("/courses/some-course-id");

    expect(navLink("Courses")).toHaveAttribute("aria-current", "page");
    expect(navLink("Dashboard")).not.toHaveAttribute("aria-current");
  });

  it("keeps the label reachable to assistive tech when collapsed to the icon rail", () => {
    renderSidebar("/", true);

    expect(navLink("Dashboard")).toHaveAttribute("aria-current", "page");
    // The visible wordmark is gone on the rail, but the account row is too —
    // the collapse control must still announce itself.
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});
