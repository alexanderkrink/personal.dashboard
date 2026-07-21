import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown, toDisplayMath } from "@/components/topic-page/markdown";

/* ────────────────────────────────────────────────────────────────────────── */
/* toDisplayMath — the pure transform                                          */
/*                                                                            */
/* remark-math typesets DISPLAY math only when the `$$` fences sit on their    */
/* own lines; `$$x$$` on a single line is inline math-text. And a blank line   */
/* inside the LaTeX is a paragraph break that splits the block and leaks the   */
/* tail as raw source. These unit tests pin both invariants and prove the      */
/* blank-line collapse leaves a multi-line aligned environment byte-for-byte.  */
/* ────────────────────────────────────────────────────────────────────────── */

describe("toDisplayMath", () => {
  it("fences each `$$` on its own line so a single-line formula is display, not inline", () => {
    // The round-1 wrap was `$$${latex}$$` — fences glued to the content on one line, which
    // remark-math parses as INLINE math. Own-line fences are what select display mode.
    expect(toDisplayMath("\\sigma / \\sqrt{n}")).toBe("$$\n\\sigma / \\sqrt{n}\n$$");
  });

  it("collapses an internal blank line so multi-line LaTeX cannot leak as raw source", () => {
    // A blank line closes the math at the break; collapsing it to a single newline keeps the
    // whole formula in one block.
    expect(toDisplayMath("\\bar{X} = \\mu\n\n\\hat{p} = X/n")).toBe(
      "$$\n\\bar{X} = \\mu\n\\hat{p} = X/n\n$$",
    );
  });

  it("trims leading and trailing blank lines before fencing", () => {
    expect(toDisplayMath("\n\n  a = b  \n\n")).toBe("$$\na = b\n$$");
  });

  it("collapses a run of blank lines with interior whitespace, not just one", () => {
    expect(toDisplayMath("a = b\n \t \n\nc = d")).toBe("$$\na = b\nc = d\n$$");
  });

  it("leaves a multi-line aligned environment untouched — no blank lines to collapse", () => {
    const aligned = "\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}";
    expect(toDisplayMath(aligned)).toBe(`$$\n${aligned}\n$$`);
  });

  it("normalises CRLF line endings to LF", () => {
    expect(toDisplayMath("a = b\r\nc = d")).toBe("$$\na = b\nc = d\n$$");
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Rendering through the shared Markdown renderer                              */
/*                                                                            */
/* Display math is `<span class="katex-display">`; inline math is a bare       */
/* `.katex`. Every assertion below is checked against the real KaTeX output.   */
/* ────────────────────────────────────────────────────────────────────────── */

describe("Markdown — display vs inline math", () => {
  it("renders a toDisplayMath-wrapped formula as centred display math", () => {
    const { container } = render(<Markdown>{toDisplayMath("\\sigma / \\sqrt{n}")}</Markdown>);
    // RED against the round-1 wrap: `$$x$$` on one line renders inline (no `.katex-display`).
    expect(container.querySelector(".katex-display")).not.toBeNull();
  });

  it("renders a blank-line formula as ONE math block, with the source in the annotation", () => {
    const { container } = render(
      <Markdown>{toDisplayMath("\\bar{X} = \\mu\n\n\\hat{p} = X/n")}</Markdown>,
    );
    // Fence-only (no collapse) would split this into TWO blocks and leak the middle as raw
    // text; the round-1 wrap renders no `.katex` at all. Exactly one clean block is the fix.
    expect(container.querySelectorAll(".katex-display")).toHaveLength(1);
    const annotation = container.querySelector('annotation[encoding="application/x-tex"]');
    expect(annotation?.textContent).toBe("\\bar{X} = \\mu\n\\hat{p} = X/n");
  });

  it("still renders a multi-line aligned environment as display math", () => {
    const aligned = "\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}";
    const { container } = render(<Markdown>{toDisplayMath(aligned)}</Markdown>);
    expect(container.querySelectorAll(".katex-display")).toHaveLength(1);
    const annotation = container.querySelector('annotation[encoding="application/x-tex"]');
    // The aligned source survives the collapse byte-for-byte.
    expect(annotation?.textContent).toBe(aligned);
  });

  it("keeps single-$ inline math inline inside a sentence (the kept decision)", () => {
    // Real extracted content carries inline `$\bar{X}$` / `$\hat{p}$`; disabling single-$
    // would break it, so it stays on. This is the regression guard for that decision.
    const { container } = render(<Markdown>{"The estimator $\\bar{X}$ is unbiased."}</Markdown>);
    const katex = container.querySelector(".katex");
    expect(katex).not.toBeNull();
    // Inline, not display: no `.katex-display` wrapper.
    expect(container.querySelector(".katex-display")).toBeNull();
    // The delimiters are consumed — the literal `$\bar{X}$` source is gone from the prose.
    expect(container.textContent).not.toContain("$\\bar{X}$");
  });

  it("renders an escaped \\$ as a literal dollar sign, not the start of math", () => {
    const { container } = render(<Markdown>{"It costs \\$5, not \\$10."}</Markdown>);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toBe("It costs $5, not $10.");
  });
});
