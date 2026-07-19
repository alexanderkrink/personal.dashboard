import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

/**
 * `vitest.config.ts` sets jsdom as the default environment, but individual
 * files opt out with `// @vitest-environment node` — route handlers must, because
 * t3-env refuses to hand a server variable to anything that looks like a client,
 * and "looks like a client" means `window` exists. Setup files run for BOTH
 * environments, so everything DOM-shaped below has to be guarded or a single
 * node test brings the whole file down with "window is not defined".
 */
const hasDom = typeof window !== "undefined";

// React Testing Library's auto-cleanup only registers itself against a global
// `afterEach`; Vitest exposes one but does not install it globally unless
// `globals: true`, which this workspace does not use. Wire it up explicitly.
afterEach(() => {
  if (hasDom) cleanup();
});

// jsdom implements neither of these, and Base UI / cmdk both touch them on mount.
if (hasDom && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

if (hasDom && !window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (hasDom && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}
