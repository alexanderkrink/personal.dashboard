import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * The dev server under test reads `.env.local` itself; the Playwright process
 * does not. The gate specs need `ACCESS_CODE` to type a correct code, so load
 * the file here. Values already present in the environment win, so CI or a
 * shell export can still override.
 *
 * `@next/env` would do this, but it is not a direct dependency and pnpm's
 * strict node_modules layout makes it unresolvable from here. `import.meta.url`
 * is not an option either: Playwright compiles this config to CommonJS.
 */
function readEnvLocal(): string | undefined {
  // Whether run from apps/web (`pnpm test:e2e` inside the app) or from the repo
  // root (`pnpm test:e2e` via the workspace filter).
  for (const candidate of [".env.local", "apps/web/.env.local"]) {
    try {
      return readFileSync(resolve(process.cwd(), candidate), "utf8");
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

function loadEnvLocal(): void {
  // No .env.local (CI, fresh clone). Specs that need a value fail loudly.
  const contents = readEnvLocal();
  if (contents === undefined) return;

  for (const line of contents.split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    const key = match?.[1];
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = (match?.[2] ?? "").replace(/^(["'])(.*)\1$/, "$2");
  }
}

loadEnvLocal();

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "html",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
  },
});
