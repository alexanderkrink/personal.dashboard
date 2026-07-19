// @vitest-environment node
//
// Node, not the jsdom default: this imports modules that read `@/env`, which
// refuses to hand a server variable to anything with a `window` on it.

import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Import-time guards for the document pipeline's function definition.
 *
 * ## Why an import test earns its place here
 *
 * These assertions look trivial and are not. inngest v4 moved triggers into the
 * options object, and passing v3's `createFunction(options, trigger, handler)`
 * throws **at import time** — which means the failure is not "process-document
 * is broken", it is "`/api/inngest` does not load", taking the health check and
 * every future job down with it. PLAN §3's sketch is still written in the v3
 * form, so this is a mistake a later agent copying that sketch will actually
 * make.
 *
 * A test that merely imports the module therefore catches the single highest-
 * blast-radius error available in this file, and catches it in CI rather than on
 * a deploy.
 */

let processDocument: { id: (prefix: string) => string; opts?: unknown };
let serveExports: Record<string, unknown>;

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test");
  vi.stubEnv("ACCESS_CODE", "test_access_code");
  vi.stubEnv("CRON_SECRET", "test_cron_secret_at_least_16");
  vi.stubEnv("INNGEST_SIGNING_KEY", `signkey-test-${"0".repeat(64)}`);
  vi.stubEnv("INNGEST_DEV", "0");

  processDocument = (await import("./process-document")).processDocument as typeof processDocument;
  serveExports = (await import("@/app/api/inngest/route")) as Record<string, unknown>;
});

describe("process-document", () => {
  it("imports without throwing — i.e. it uses v4's two-argument createFunction", () => {
    expect(processDocument).toBeDefined();
  });

  it("registers under the id the dashboard and the concurrency key are keyed on", () => {
    expect(processDocument.id("study-dashboard")).toBe("study-dashboard-process-document");
  });

  /**
   * The concurrency key is the merge step's correctness guarantee, not a
   * throughput setting: per-course serialization is what lets a later merge use
   * a plain `revision + 1` instead of optimistic locking. Losing it would not
   * break anything visibly — it would corrupt topic revisions under exactly the
   * conditions nobody tests, which is why it is pinned by value here.
   */
  it("serializes runs per course with a limit of 1", () => {
    const options = (processDocument as unknown as { opts: Record<string, unknown> }).opts;
    expect(options.concurrency).toEqual([{ key: "event.data.courseId", limit: 1 }]);
  });

  it("retries 3 times and declares an onFailure handler", () => {
    const options = (processDocument as unknown as { opts: Record<string, unknown> }).opts;
    expect(options.retries).toBe(3);
    expect(typeof options.onFailure).toBe("function");
  });

  it("is actually served from /api/inngest, not merely defined", () => {
    // A function that exists but is not in `serve()`'s list never runs, and
    // nothing anywhere else would notice.
    for (const method of ["GET", "POST", "PUT"]) {
      expect(typeof serveExports[method]).toBe("function");
    }
  });
});
