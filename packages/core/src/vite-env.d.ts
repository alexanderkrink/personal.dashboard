/**
 * Types for the two Vite transforms the calendar fixture tests rely on:
 * `?raw` imports and `import.meta.glob`.
 *
 * These are declared by hand rather than via `/// <reference types="vite/client" />`
 * because `vite` is not a direct dependency of this package — and it should not
 * become one. `packages/core` deliberately has **no `@types/node`**, which is
 * what turns the CLAUDE.md boundary rule ("must stay runnable in browser, node,
 * edge, WASM") into a compiler-enforced invariant: a `node:fs` import anywhere
 * in `src` fails typecheck. Pulling in a toolchain package that transitively
 * supplies Node types would quietly disarm that guard for all of `src`.
 *
 * `import.meta.glob` is what lets the Tier-2 test read the gitignored real
 * export: a glob that matches nothing yields `{}`, so the suite skips cleanly on
 * CI rather than throwing on a missing file.
 */

declare module "*?raw" {
  const content: string;
  export default content;
}

interface ImportMeta {
  glob(
    pattern: string,
    options: { query: "?raw"; import: "default"; eager: true },
  ): Record<string, string>;
}
