// @vitest-environment node
//
// Node, not the jsdom default: this imports `@/env`, and t3-env refuses to hand
// a server variable to anything with a `window` on it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Dev mode is an authentication bypass, so it gets tests of its own.
 *
 * `/api/inngest` is gate-exempt and accepts POST; the only thing standing in
 * front of it is Inngest's signature check, and `serve()` skips that check
 * entirely in dev mode. Reproduced against a production build: with
 * `INNGEST_DEV=1`, an unsigned POST ran the health check and wrote a
 * `job_heartbeats` row for an arbitrary user id through the RLS-bypassing admin
 * client. These tests pin the two things that keep that from reaching production.
 */
const BASE_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ACCESS_CODE: "test_access_code",
  CRON_SECRET: "test_cron_secret_long_enough",
  INNGEST_SIGNING_KEY: `signkey-test-${"a".repeat(64)}`,
};

beforeEach(() => {
  vi.resetModules();
  for (const [k, v] of Object.entries(BASE_ENV)) vi.stubEnv(k, v);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("INNGEST_DEV validation in env.ts", () => {
  it.each(["0", "1", "true", "false"])("accepts the parseable value %s", async (value) => {
    vi.stubEnv("INNGEST_DEV", value);
    await expect(import("@/env")).resolves.toBeDefined();
  });

  it("accepts being unset, which is how production runs", async () => {
    vi.stubEnv("INNGEST_DEV", "");
    await expect(import("@/env")).resolves.toBeDefined();
  });

  it.each(["yes", "dev", "on", "http://localhost:8288", "y"])(
    "REJECTS %s, which the SDK would read as a URL and treat as dev mode",
    async (value) => {
      // This is the sharp edge. `Inngest.mode` calls `parseAsBoolean` first, and
      // when that returns undefined it falls through to `explicitDevUrl`, which
      // runs the raw string through `new URL(normalizeUrl(value))`. `yes` becomes
      // `http://yes` — a valid URL — so the SDK silently enters dev mode and
      // stops verifying signatures. Failing the build is the whole point.
      vi.stubEnv("INNGEST_DEV", value);
      await expect(import("@/env")).rejects.toThrow();
    },
  );
});

describe("production dev-mode assertion in client.ts", () => {
  it("throws when dev mode is active in a production deployment", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("INNGEST_DEV", "1");
    await expect(import("@/inngest/client")).rejects.toThrow(/dev mode in a production/i);
  });

  it("stays silent in a production deployment that is correctly in cloud mode", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("INNGEST_DEV", "");
    const mod = await import("@/inngest/client");
    expect(mod.inngest.mode).toBe("cloud");
  });

  it("does not fire locally or in CI, where INNGEST_DEV=1 is legitimate", async () => {
    // A guard that broke `pnpm dev` would be removed within the week, so it is
    // scoped to the one environment where dev mode is genuinely dangerous.
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("INNGEST_DEV", "1");
    const mod = await import("@/inngest/client");
    expect(mod.inngest.mode).toBe("dev");
  });
});
