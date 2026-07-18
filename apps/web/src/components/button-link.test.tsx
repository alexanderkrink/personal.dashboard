import { render, screen } from "@testing-library/react";
import Link from "next/link";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ButtonLink } from "@/components/button-link";
import { Button } from "@/components/ui/button";

/**
 * REGRESSION: `<Button render={<Link />}>` renders nothing at all.
 *
 * Base UI's `Button` defaults to `nativeButton: true`. Handed an `<a>` under
 * that assumption it raises, React unwinds the subtree, and the route paints an
 * empty `<main>` — the page header, the table and the empty state all silently
 * gone. It typechecks, it lints, and it builds; the failure only exists at
 * runtime, which is the most expensive place to find it.
 *
 * These tests exist because that is exactly how it was found: three pages of
 * this feature shipped blank through a green verify chain, and a live click-
 * through was the first thing that noticed.
 */

const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

afterEach(() => {
  errorSpy.mockClear();
});

describe("ButtonLink", () => {
  it("renders an anchor, not a button", () => {
    render(<ButtonLink href="/courses">Courses</ButtonLink>);

    const link = screen.getByRole("link", { name: "Courses" });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/courses");
  });

  it("keeps the button's visual variants", () => {
    render(
      <ButtonLink href="/courses" variant="ghost">
        Semesters
      </ButtonLink>,
    );

    // The 44px coarse-pointer target is on every size variant and must survive
    // the swap to an anchor.
    expect(screen.getByRole("link", { name: "Semesters" })).toHaveClass("pointer-coarse:h-11");
  });

  it("is announced as a link, never as a button", () => {
    // The near-miss fix for the crash was `nativeButton={false}`, which stops
    // Base UI raising but stamps `role="button"` on the anchor — a control that
    // navigates, announced as one that acts. That is a quieter bug than a blank
    // page, not a smaller one.
    render(<ButtonLink href="/courses">Courses</ButtonLink>);

    expect(screen.getByRole("link", { name: "Courses" })).not.toHaveAttribute("role", "button");
    expect(screen.queryByRole("button", { name: "Courses" })).toBeNull();
  });

  it("raises no Base UI complaint, because it uses no Base UI button", () => {
    render(<ButtonLink href="/courses">Courses</ButtonLink>);

    const complaints = errorSpy.mock.calls.filter((call) =>
      String(call[0]).includes("expected a native <button>"),
    );
    expect(complaints).toHaveLength(0);
  });

  it("the raw `Button render={<Link/>}` it replaces DOES trip it", () => {
    // Pin the reason this component exists. If Base UI ever stops caring, this
    // is the test that says so, and `ButtonLink` can be reconsidered rather
    // than cargo-culted.
    try {
      render(<Button render={<Link href="/courses" />}>Courses</Button>);
    } catch {
      // Raising is one of the two acceptable outcomes; complaining is the other.
    }

    const complaints = errorSpy.mock.calls.filter((call) =>
      String(call[0]).includes("expected a native <button>"),
    );
    expect(complaints.length).toBeGreaterThan(0);
  });
});
