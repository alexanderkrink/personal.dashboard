import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("merges conditional class names", () => {
    expect(cn("a", false && "b", "c")).toBe("a c");
  });

  it("resolves conflicting tailwind classes to the last one", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });
});

/**
 * REGRESSION SUITE.
 *
 * `cn` was bare `twMerge`, which only knows Tailwind's stock scales. Every
 * custom token in `globals.css` was therefore mis-classified, and the damage was
 * SILENT — nothing throws, the class simply is not in the DOM. The type-scale
 * case was live: a `text-ui-base text-destructive` pair resolved as two COLOURS
 * in conflict, the size lost, and the element rendered at the browser default of
 * 16px instead of the 13px the design system specifies.
 *
 * These assert the classification, not the visual result. Adding a token to
 * `globals.css` without adding it to `utils.ts` should fail here.
 */
describe("cn with the project's custom theme tokens", () => {
  it("keeps a type token and a colour token together — they are not the same axis", () => {
    expect(cn("text-ui-base", "text-destructive")).toBe("text-ui-base text-destructive");
    expect(cn("text-destructive", "text-ui-base")).toBe("text-destructive text-ui-base");
  });

  it.each([
    "ui-xs",
    "ui-sm",
    "ui-base",
    "ui-md",
    "ui-lg",
    "ui-xl",
    "read-body",
    "read-h3",
    "read-h2",
    "read-h1",
    "read-cap",
    "mono-data",
    "mono-code",
    "num-hero",
    "num-hero-lg",
    "num-hero-xl",
    "wordmark",
  ])("classifies text-%s as a font size, not a colour", (token) => {
    expect(cn(`text-${token}`, "text-muted-foreground")).toBe(
      `text-${token} text-muted-foreground`,
    );
  });

  it("still lets one type token override another", () => {
    expect(cn("text-ui-base", "text-ui-lg")).toBe("text-ui-lg");
    expect(cn("text-num-hero", "text-num-hero-xl")).toBe("text-num-hero-xl");
  });

  it("lets a custom type token override a stock one and vice versa", () => {
    expect(cn("text-sm", "text-ui-base")).toBe("text-ui-base");
    expect(cn("text-ui-base", "text-sm")).toBe("text-sm");
  });

  it("still resolves colour conflicts between custom colours", () => {
    expect(cn("text-accent-text", "text-muted-foreground")).toBe("text-muted-foreground");
    expect(cn("border-input-border", "border-destructive")).toBe("border-destructive");
  });

  it("conflicts named durations with each other and with the numeric scale", () => {
    expect(cn("duration-fast", "duration-slow")).toBe("duration-slow");
    expect(cn("duration-fast", "duration-200")).toBe("duration-200");
    expect(cn("duration-200", "duration-base")).toBe("duration-base");
  });

  it("conflicts the custom easings with each other and with the stock ones", () => {
    expect(cn("ease-out-quart", "ease-out-expo")).toBe("ease-out-expo");
    expect(cn("ease-out-quart", "ease-linear")).toBe("ease-linear");
    expect(cn("ease-in", "ease-out-quart")).toBe("ease-out-quart");
  });

  it("conflicts the reading radius with the cockpit scale", () => {
    expect(cn("rounded-reading", "rounded-lg")).toBe("rounded-lg");
    expect(cn("rounded-lg", "rounded-reading")).toBe("rounded-reading");
  });

  it("conflicts the custom font families, and leaves weight alone", () => {
    expect(cn("font-mono", "font-heading")).toBe("font-heading");
    expect(cn("font-medium", "font-mono")).toBe("font-medium font-mono");
  });

  it("keeps a responsive variant separate from the unprefixed class", () => {
    // Why `gate-form.tsx` carries `md:text-mono-data` as well as the bare one.
    expect(cn("text-base md:text-sm", "text-mono-data")).toBe("md:text-sm text-mono-data");
  });

  it("keeps the pointer-coarse touch-target override alongside the base height", () => {
    expect(cn("h-8", "pointer-coarse:h-11")).toBe("h-8 pointer-coarse:h-11");
    expect(cn("size-8 pointer-coarse:size-11", "size-9")).toBe("pointer-coarse:size-11 size-9");
  });
});
