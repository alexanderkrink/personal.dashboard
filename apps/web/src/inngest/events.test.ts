// @vitest-environment node

import { describe, expect, it } from "vitest";
import { healthCheckRequested, healthCheckRequestedData } from "@/inngest/events";

/**
 * Why these tests exist at all.
 *
 * Passing a Zod schema to `eventType` looks like it validates incoming events.
 * It does not — it types them. That gap matters here because `event.data.userId`
 * becomes the owner of a row written through `createAdminSupabaseClient`, which
 * bypasses RLS, so it is exactly the kind of value the repo's "Zod at every
 * boundary" rule exists to cover. The handler therefore calls `safeParse`
 * itself, and these tests pin both halves: that the library really does let bad
 * data through, and that the exported schema really does stop it.
 */
describe("eventType does NOT validate on the way in", () => {
  it("accepts a payload its own schema rejects", () => {
    // If this ever starts throwing, inngest has added receive-side validation
    // and the explicit `safeParse` in the handler could be revisited. Until
    // then, removing that parse would silently reopen the hole.
    const built = healthCheckRequested.create({ userId: "not-a-uuid" });
    expect(built.data).toEqual({ userId: "not-a-uuid" });
  });
});

describe("healthCheckRequestedData is what actually guards the boundary", () => {
  it("accepts a well-formed uuid", () => {
    const r = healthCheckRequestedData.safeParse({
      userId: "0092dd81-4436-452f-9517-235cc8ea4cf2",
    });
    expect(r.success).toBe(true);
  });

  it.each([
    ["a non-uuid string", { userId: "not-a-uuid" }],
    ["a missing userId", {}],
    ["a null userId", { userId: null }],
    ["a numeric userId", { userId: 42 }],
    ["a SQL-ish string", { userId: "' or 1=1 --" }],
  ])("rejects %s", (_label, data) => {
    // Verified end to end before this test was written: pre-fix, `not-a-uuid`
    // reached Postgres and came back as a generic *retriable* error, so a
    // malformed event burned the retry budget instead of failing fast.
    expect(healthCheckRequestedData.safeParse(data).success).toBe(false);
  });
});
