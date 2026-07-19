// @vitest-environment node
//
// Node, not the jsdom default: this exercises a route handler, and `@/env`
// refuses to hand a server variable to anything with a `window` on it.

import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The gate carve-out's evidence.
 *
 * `/api/inngest` is listed in `UNGATED_PATHS`, so it is reachable with no
 * session and no access-code cookie, and it is the only entry there that
 * accepts POST and PUT. The repo rule it bends is documented in
 * `lib/supabase/proxy-session.ts`; the thing that pays for bending it is
 * `INNGEST_SIGNING_KEY`. These tests assert that payment is real — not that the
 * route exists, but that it REFUSES a request Inngest did not sign.
 *
 * If these tests are deleted, the entry in `UNGATED_PATHS` must go too.
 */

/**
 * ⚠ The trap this file exists to avoid.
 *
 * Inngest skips signature verification entirely in dev mode, and it infers dev
 * mode from `NODE_ENV`, which Vitest sets to "test". So the naive version of
 * this test — POST to the handler, expect a refusal — passes for the wrong
 * reason under the default config: it would pass just as happily against a
 * route with no signing key configured at all, because nothing would be
 * verified either way.
 *
 * `INNGEST_DEV=0` forces the production code path, which is the only one that
 * ships. It has to be set before the route module is imported, since the client
 * and the serve handler both read the environment at module scope — hence the
 * dynamic import below rather than a top-level one.
 */
let POST: (request: Request, context: unknown) => Promise<Response>;
let PUT: (request: Request, context: unknown) => Promise<Response>;

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test");
  vi.stubEnv("ACCESS_CODE", "test_access_code");
  vi.stubEnv("CRON_SECRET", "test_cron_secret_long_enough");
  vi.stubEnv("INNGEST_SIGNING_KEY", `signkey-test-${"a".repeat(64)}`);
  vi.stubEnv("INNGEST_DEV", "0");

  const route = await import("@/app/api/inngest/route");
  POST = route.POST as typeof POST;
  PUT = route.PUT as typeof PUT;
});

/** A request shaped like a real function invocation, minus the signature. */
function invocation(headers: Record<string, string> = {}): Request {
  return new Request(
    "https://example.com/api/inngest?fnId=study-dashboard-health-check&stepId=step",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        event: {
          name: "system/health-check.requested",
          data: { userId: "00000000-0000-4000-8000-000000000000" },
        },
        ctx: { attempt: 0, run_id: "01JTEST" },
        steps: {},
      }),
    },
  );
}

describe("POST /api/inngest (function invocation)", () => {
  it("rejects a request carrying no signature", async () => {
    const response = await POST(invocation(), undefined);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ message: "Unauthorized" });
  });

  it("rejects a request carrying a forged signature", async () => {
    // A missing header and a wrong one must both fail. Only the first is
    // covered by "did we remember to check?"; this one covers "does the check
    // actually verify anything?", which is the property the carve-out needs.
    const response = await POST(
      invocation({
        "x-inngest-signature": `t=${Math.floor(Date.now() / 1000)}&s=${"0".repeat(64)}`,
      }),
      undefined,
    );

    expect(response.status).toBe(401);
  });

  it("refuses without running any function code", async () => {
    // The health check writes to the database as its first act. If a refusal
    // ever came back AFTER the handler body ran, an unauthenticated caller
    // could drive writes through a gate-exempt endpoint — so assert the
    // rejection is the whole response and carries no run result.
    const response = await POST(invocation(), undefined);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(body).not.toHaveProperty("heartbeatId");
    expect(body).not.toHaveProperty("ok");
  });
});

describe("PUT /api/inngest (app sync)", () => {
  it("is exported, because Inngest syncs with PUT", () => {
    // PUT is the other half of why this route had to break the GET-only rule,
    // so its presence is part of the carve-out's shape and worth pinning.
    //
    // Its REFUSAL, though, is deliberately not asserted here. An unsigned PUT
    // does return 401 ("Your signing key is invalid"), but only because Inngest
    // validates the key against api.inngest.com — the check is a live network
    // call, so asserting it would make CI depend on a third party's uptime and
    // would fail closed for the wrong reason offline. Verified by hand instead:
    // in production mode an unsigned PUT answers 401, in dev mode 500.
    //
    // The security-critical direction is POST, and that is covered above: PUT
    // only re-registers which functions this app serves, and cannot execute one.
    expect(PUT).toBeTypeOf("function");
  });
});
