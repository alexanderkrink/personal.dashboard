import ReactMarkdown, { type Options } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

/**
 * The reading register's markdown renderer, and the remark plugin chain that is this
 * feature's documented extension point (PLAN §8: *"the remark plugin chain is the extension
 * point the Bilingual Term Layer and Obsidian export later hook into"*).
 *
 * ## Why the chain is a named constant rather than an inline array
 *
 * Because the next two features that touch it are both *transformations of the tree*, and
 * the cheap way to build either of them is a `components` override or a string replace in
 * the calling component — which works, ships, and quietly forecloses the plugin chain by
 * putting the behaviour somewhere a plugin cannot see it. Naming the list and pointing at
 * it from here makes the intended seam the obvious one.
 *
 * ## The math chain lives here, once
 *
 * `remark-math` parses `$…$` / `$$…$$`, and `rehype-katex` typesets the resulting nodes to
 * HTML + MathML at render time — so inline math in prose (notes, definitions, examples) AND
 * the formula block (which wraps its LaTeX in `$$…$$`, see `TopicPageBody`) all go through
 * this single chain. Item 7's exam review reuses this renderer, so KaTeX belongs *here* and
 * in the one global `katex.min.css` import in `layout.tsx`, never inline in a component.
 *
 * The KaTeX CSS/woff2 are self-hosted through the bundler (no CDN → CSP-clean); glyphs
 * inherit `currentColor`, so both reading themes typeset with no per-theme override.
 */
export const REMARK_PLUGINS: NonNullable<Options["remarkPlugins"]> = [remarkGfm, remarkMath];

/**
 * The rehype half of the chain. `throwOnError: false` makes model-produced LaTeX that is
 * malformed render as an inline KaTeX error node instead of crashing SSR; `trust: false`
 * blocks `\href` / `\includegraphics` injection from the same untrusted source.
 */
export const REHYPE_PLUGINS: NonNullable<Options["rehypePlugins"]> = [
  [rehypeKatex, { throwOnError: false, trust: false }],
];

/**
 * Wraps a formula's raw LaTeX as a **display-math block** for {@link Markdown}.
 *
 * The one load-bearing move is fencing: each `$$` must sit on its **own line** (`$$\n…\n$$`).
 * `$$x$$` written on a single line is parsed as inline math-text and renders inside a `<p>`,
 * exactly like `$x$` — the dollar count does **not** select display mode, the fence being
 * flow-level does. This is the whole display-vs-inline distinction the formula block turns on,
 * and the reason the old `` `$$${latex}$$` `` wrap rendered every standalone formula inline.
 *
 * Own-line fences also parse as `remark-math`'s flow (display) construct, which is `concrete`
 * — like a fenced code block, it runs to its closing fence and **absorbs interior blank lines
 * as content**. So a blank line inside the fences does not split the block or leak raw source;
 * that failure is specific to the *inline* `$$x$$` form the old wrap produced.
 *
 * The whitespace normalisation (CRLF→LF, trim, collapse runs of blank lines to a single
 * newline) is therefore **annotation hygiene, not a leak guard**: the display math renders
 * identically with or without it, but the collapsed form is the TeX that KaTeX copies into the
 * `<annotation>` (its copy-selectable source), so we keep stray blank lines out of that. It is
 * safe for multi-line aligned environments (`\begin{aligned} … \\ … \end{aligned}`): those
 * separate rows with `\\` and a *single* newline, never a blank line, so there is nothing for
 * the collapse to touch — the TeX survives byte-for-byte in the annotation.
 */
export function toDisplayMath(latex: string): string {
  const normalised = latex
    .replace(/\r\n?/g, "\n")
    .trim()
    .replace(/\n[ \t]*\n+/g, "\n");
  return `$$\n${normalised}\n$$`;
}

/**
 * Renders study prose.
 *
 * Deliberately has **no** typography classes of its own beyond the ones that make tables
 * and code legible: the `.reading` wrapper further up owns the serif face, the measure and
 * the colour, and a second opinion about type inside this component is how two registers
 * become three. `prose-*` utilities are not used at all — the reading register is defined
 * in `globals.css` against tokens, and Tailwind Typography would layer a second, untinted
 * type scale on top of it.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      components={{
        // Blocks inside a topic page sit under the block's own heading, so the model's
        // markdown headings step down rather than competing with it.
        h1: ({ children: c }) => <h4 className="mt-4 mb-1 font-semibold text-read-h3">{c}</h4>,
        h2: ({ children: c }) => <h4 className="mt-4 mb-1 font-semibold text-read-h3">{c}</h4>,
        h3: ({ children: c }) => <h5 className="mt-3 mb-1 font-semibold text-read-body">{c}</h5>,
        p: ({ children: c }) => <p className="my-2">{c}</p>,
        ul: ({ children: c }) => <ul className="my-2 list-disc space-y-1 pl-5">{c}</ul>,
        ol: ({ children: c }) => <ol className="my-2 list-decimal space-y-1 pl-5">{c}</ol>,
        li: ({ children: c }) => <li>{c}</li>,
        strong: ({ children: c }) => <strong className="font-semibold">{c}</strong>,
        blockquote: ({ children: c }) => (
          <blockquote className="my-3 border-border border-l-2 pl-4 text-muted-foreground italic">
            {c}
          </blockquote>
        ),
        // Mono inside the reading register, per "the two registers, explicitly": code,
        // locators and formulas stay instrument-typed so the registers interlock.
        code: ({ children: c }) => (
          <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.9em]">{c}</code>
        ),
        pre: ({ children: c }) => (
          <pre className="my-3 overflow-x-auto rounded-lg bg-muted p-3 font-mono text-ui-sm">
            {c}
          </pre>
        ),
        // A table wider than the measure scrolls itself rather than the page.
        table: ({ children: c }) => (
          <div className="my-3 overflow-x-auto">
            <table className="w-full border-collapse font-sans text-ui-sm">{c}</table>
          </div>
        ),
        th: ({ children: c }) => (
          <th className="border-border border-b px-2 py-1 text-left font-semibold">{c}</th>
        ),
        td: ({ children: c }) => <td className="border-border/60 border-b px-2 py-1">{c}</td>,
        a: ({ children: c, href }) => (
          <a className="text-primary underline underline-offset-2" href={href}>
            {c}
          </a>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
