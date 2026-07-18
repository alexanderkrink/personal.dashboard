import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // `tsconfig.json` sets `jsx: "preserve"` (Next.js owns the JSX transform in
  // the app build). Vitest has no Next.js in front of it, so it must compile
  // JSX itself — without this every `.tsx` test dies with "Unexpected JSX
  // expression". Vitest 4 runs on Vite 8 / Rolldown, so the knob is `oxc`;
  // the `esbuild` option this used to be does nothing here.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // apps/web ONLY. `packages/*` deliberately stay on the node environment —
    // `@study/core` in particular must remain runnable anywhere (browser, node,
    // edge, WASM), so nothing there may quietly start reaching for a DOM.
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
