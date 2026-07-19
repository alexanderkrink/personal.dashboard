/**
 * The exact Web Standard globals `@study/ai` depends on.
 *
 * The package must stay runnable anywhere — node, edge, a browser, a test — so its tsconfig
 * deliberately carries no `DOM` lib and no `@types/node`. Either would compile, but both
 * would also quietly admit `document`, `process` and friends into a package whose whole job
 * is to be environment-free.
 *
 * So the dependency is declared explicitly instead: these two APIs, nothing more. Anything
 * that needs a third global has to add it here, in the open, where a reviewer sees it.
 */

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare var crypto: {
  readonly subtle: {
    digest(
      algorithm: string,
      data: ArrayBuffer | ArrayBufferView<ArrayBufferLike>,
    ): Promise<ArrayBuffer>;
  };
};

/**
 * `fetch`, narrowed to what the Voyage embedding client actually uses.
 *
 * Declared structurally rather than pulled in from `DOM` or `@types/node` for the reason in
 * the module note: either lib would admit the whole environment along with the one function
 * needed.
 *
 * ⚠ The shape is written INLINE rather than as a named alias, and it deliberately mirrors
 * `FetchLike` in `embeddings.ts`. An ambient `.d.ts` is only visible to a compilation that
 * includes it, and `apps/web` typechecks this package's sources under its OWN tsconfig,
 * where this file is not in the include set — so a named type declared here is simply not
 * found over there. The types that cross that boundary have to be real module exports;
 * only the ambient binding of the global itself can live here. Structural typing is what
 * makes the two agree, and `embeddings.test.ts` exercises the exported one.
 */
declare var fetch: (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;
