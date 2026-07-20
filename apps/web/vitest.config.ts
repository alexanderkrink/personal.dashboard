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
    // Under `turbo run --force`, every package's suite runs concurrently and
    // jsdom + userEvent tests that take ~50ms alone have blown vitest's 5s/10s
    // defaults purely from CPU contention (process-document at gate 0,
    // history-drawer and delete-document-dialog at gate 6 — all pass alone in
    // milliseconds). These bounds only decide when a HUNG test is declared
    // dead; 30s changes nothing for a healthy suite and stops load from
    // forging failures.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
