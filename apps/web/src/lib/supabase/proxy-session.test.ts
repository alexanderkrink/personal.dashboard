// @vitest-environment node
//
// Node, not the jsdom default: `proxy-session.ts` pulls in `@/env`, and t3-env
// refuses to hand a server variable to anything with a `window` on it.

import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The blast radius of the gate exemptions.
 *
 * `UNGATED_PATHS` is the shortest list in the app and the most dangerous one:
 * everything on it is reachable with no session and no access code. Wave 1
 * shipped a full auth bypass by putting one wrong string in it. These tests pin
 * the two properties that keep it contained — that it matches whole path
 * segments rather than characters, and that its membership is exactly what was
 * argued for in the file's comment and nothing more.
 */
let UNGATED_PATHS: readonly string[];
let startsWithAny: (pathname: string, prefixes: readonly string[]) => boolean;

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test");
  vi.stubEnv("ACCESS_CODE", "test_access_code");
  vi.stubEnv("CRON_SECRET", "test_cron_secret_long_enough");
  vi.stubEnv("INNGEST_SIGNING_KEY", `signkey-test-${"a".repeat(64)}`);

  const mod = await import("@/lib/supabase/proxy-session");
  UNGATED_PATHS = mod.UNGATED_PATHS;
  startsWithAny = mod.startsWithAny;
});

const ungated = (pathname: string) => startsWithAny(pathname, UNGATED_PATHS);

describe("startsWithAny matches whole segments, not characters", () => {
  it("exempts the carve-out itself and its subpaths", () => {
    expect(ungated("/api/inngest")).toBe(true);
    expect(ungated("/api/inngest/")).toBe(true);
    expect(ungated("/api/inngest/anything")).toBe(true);
  });

  it.each([
    "/api/inngest-foo",
    "/api/inngestX",
    "/api/inngest-admin",
    "/api/inngest.json",
    "/api/inngestible",
  ])("does NOT exempt the sibling path %s", (pathname) => {
    // A plain `startsWith(prefix)` would return true for every one of these,
    // silently turning one carve-out into a namespace of them. This is the
    // assertion that would catch that regression.
    expect(ungated(pathname)).toBe(false);
  });

  it("does not exempt a path that merely contains an exempt one", () => {
    expect(ungated("/decoy/api/inngest")).toBe(false);
    expect(ungated("/api/cron-jobs")).toBe(false);
    expect(ungated("/api/hooks2")).toBe(false);
  });

  it.each(["/API/INNGEST", "/Api/Inngest", "/api/Inngest"])(
    "does not exempt the case variant %s",
    (pathname) => {
      // Matching is case-sensitive and the routes are lowercase, so these fail
      // closed twice over: gated here, and 404 at the router even if they were not.
      expect(ungated(pathname)).toBe(false);
    },
  );

  it.each(["/api/inngest%2Fadmin", "//api/inngest", " /api/inngest"])(
    "does not exempt the malformed variant %s",
    (pathname) => {
      expect(ungated(pathname)).toBe(false);
    },
  );

  it("matches traversal strings, which Next normalises away before we see them", () => {
    // Documented, not celebrated. `startsWithAny` is a string function and does
    // no normalisation, so the literal `/api/inngest/../dashboard` matches the
    // prefix. Next resolves `..` before populating `nextUrl.pathname`, so the
    // proxy is handed `/dashboard` and gates it — confirmed against a production
    // build with `curl --path-as-is` (raw, `%2e%2e` and mixed-case variants all
    // 307 to `/`). This assertion exists so the borrowed guarantee is visible:
    // if it ever changes, the failure lands here rather than in production.
    expect(ungated("/api/inngest/../dashboard")).toBe(true);
  });
});

describe("UNGATED_PATHS membership", () => {
  it("is exactly the five documented entries", () => {
    // Deliberately an equality assertion, not a `toContain`. Adding an entry
    // here should force a conscious edit to this test and a reader back to the
    // security comment in proxy-session.ts, which spells out what an entry has
    // to prove about itself before it earns a place.
    expect(UNGATED_PATHS).toEqual([
      "/auth/confirm",
      "/auth/callback",
      "/api/hooks",
      "/api/cron",
      "/api/inngest",
    ]);
  });

  it("exempts no page routes — only /api and the email-link landings", () => {
    // The rule the Wave 1 bypass broke: a page is a Server Action host, so
    // exempting one exempts signUp/signIn/resetPassword with it. `/auth/confirm`
    // and `/auth/callback` are route handlers despite living under /auth.
    for (const path of UNGATED_PATHS) {
      expect(path.startsWith("/api/") || path.startsWith("/auth/")).toBe(true);
    }
    expect(ungated("/auth/update-password")).toBe(false);
    expect(ungated("/login")).toBe(false);
    expect(ungated("/signup")).toBe(false);
    expect(ungated("/")).toBe(false);
  });
});
