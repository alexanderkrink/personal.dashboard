// @vitest-environment node
//
// Node, not the jsdom default: this imports modules that read `@/env`, which refuses to hand a
// server variable to anything with a `window` on it.

import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The dedup CONFIG of `generate-review` — the request-level half of the double-bill guard.
 *
 * Per-course `concurrency: 1` serializes runs, and `idempotency: "event.data.requestId"` makes
 * two sends of the SAME request collapse to one run at the platform level. Both are load-bearing
 * money guards, not throughput settings: without the idempotency key a double-click (which reuses
 * the button's requestId) would enqueue a second ~$0.50–1.50 Opus run behind the first. They are
 * pinned by value here so removing either fails CI rather than a bill.
 */

let generateReview: { id: (prefix: string) => string; opts?: unknown };
let serveExports: Record<string, unknown>;

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test");
  vi.stubEnv("ACCESS_CODE", "test_access_code");
  vi.stubEnv("CRON_SECRET", "test_cron_secret_at_least_16");
  vi.stubEnv("INNGEST_SIGNING_KEY", `signkey-test-${"0".repeat(64)}`);
  vi.stubEnv("VOYAGE_API_KEY", "pa-test");
  vi.stubEnv("CLOUDCONVERT_API_KEY", "cc-test");
  vi.stubEnv("INNGEST_DEV", "0");

  generateReview = (await import("./generate-review")).generateReview as typeof generateReview;
  serveExports = (await import("@/app/api/inngest/route")) as Record<string, unknown>;
});

describe("generate-review", () => {
  it("imports without throwing (v4 two-argument createFunction)", () => {
    expect(generateReview).toBeDefined();
  });

  it("registers under its id", () => {
    expect(generateReview.id("study-dashboard")).toBe("study-dashboard-generate-review");
  });

  it("serializes runs per course with a limit of 1", () => {
    const options = (generateReview as unknown as { opts: Record<string, unknown> }).opts;
    expect(options.concurrency).toEqual([{ key: "event.data.courseId", limit: 1 }]);
  });

  // RED when the request-level dedup guard is neutralised (drop the `idempotency` field): two
  // sends of the same requestId — a double-click, or a click racing the button's disable — would
  // then each enqueue a billed Opus run instead of collapsing to one.
  it("dedupes by the caller's requestId so a double-click cannot enqueue a second Opus run", () => {
    const options = (generateReview as unknown as { opts: Record<string, unknown> }).opts;
    expect(options.idempotency).toBe("event.data.requestId");
  });

  it("retries, but not forever", () => {
    const options = (generateReview as unknown as { opts: Record<string, unknown> }).opts;
    expect(options.retries).toBe(2);
  });

  it("is served from /api/inngest so it actually runs", () => {
    // The route module imports and lists the function; importing it without throwing is the
    // registration smoke test (the Wave 4 loss was an unregistered function).
    expect(serveExports.POST).toBeDefined();
    expect(serveExports.PUT).toBeDefined();
  });
});
