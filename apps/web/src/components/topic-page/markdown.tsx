import ReactMarkdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";

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
 * Nothing beyond GFM is installed yet. `remark-math` + KaTeX is the known next addition
 * (formulas currently render as their LaTeX source, see `FormulaList`), and it belongs
 * *here* when it lands, not in a component.
 */
export const REMARK_PLUGINS: NonNullable<Options["remarkPlugins"]> = [remarkGfm];

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
