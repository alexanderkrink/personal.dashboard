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
