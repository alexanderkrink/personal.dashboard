// @vitest-environment node

import type { SupabaseAdminClient } from "@study/db";
import { NonRetriableError } from "inngest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveOwner, OwnedRowNotFoundError, OwnerMismatchError } from "@/inngest/owner";

/**
 * Why these tests exist.
 *
 * `events.ts` validated `userId: z.uuid()` and every handler trusted the result. That
 * types the value; it does not authorise it. Jobs run under `createAdminSupabaseClient`,
 * which bypasses RLS, so "well-formed uuid" was the ONLY thing standing between a signed
 * event and a row written into someone else's tenant. These pin the replacement rule: the
 * database says who owns the row, the payload only gets to agree.
 */

const ALICE = "0092dd81-4436-452f-9517-235cc8ea4cf2";
const BOB = "87448aa7-a70a-4186-aab2-23ef105675f3";
const ROW = "11111111-2222-3333-4444-555555555555";

/** A stub of the single PostgREST chain `deriveOwner` issues. */
function stubClient(result: {
  data?: Record<string, unknown> | null;
  error?: { message: string };
}) {
  const maybeSingle = vi
    .fn()
    .mockResolvedValue({ data: result.data ?? null, error: result.error ?? null });
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { client: { from } as unknown as SupabaseAdminClient, from, select, eq, maybeSingle };
}

describe("deriveOwner reads ownership out of the database", () => {
  it("returns the row's owner, not the one the event claimed", async () => {
    const { client } = stubClient({ data: { user_id: ALICE } });
    await expect(
      deriveOwner(client, { table: "syllabus_extractions", id: ROW }, { job: "process-document" }),
    ).resolves.toEqual({ userId: ALICE, table: "syllabus_extractions", rowId: ROW });
  });

  it("queries the owned table by id and selects user_id", async () => {
    const { client, from, select, eq } = stubClient({ data: { user_id: ALICE } });
    await deriveOwner(client, { table: "job_heartbeats", id: ROW }, { job: "health-check" });
    expect(from).toHaveBeenCalledWith("job_heartbeats");
    expect(select).toHaveBeenCalledWith("user_id");
    expect(eq).toHaveBeenCalledWith("id", ROW);
  });

  it("knows profiles is keyed by id, because a profile IS a user", async () => {
    // The owner column is derived from the table name and is never caller-supplied —
    // handing that choice to the caller is what the module exists to prevent.
    const { client, select, eq } = stubClient({ data: { id: ALICE } });
    await expect(
      deriveOwner(client, { table: "profiles", id: ALICE }, { job: "health-check" }),
    ).resolves.toMatchObject({ userId: ALICE });
    expect(select).toHaveBeenCalledWith("id");
    expect(eq).toHaveBeenCalledWith("id", ALICE);
  });
});

describe("a payload that contradicts the database is a security event", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("refuses when the claimed userId is not the row's owner", async () => {
    // THE HOLE (#2). Before this, the handler took Bob's word for it and wrote a row
    // owned by Bob against Alice's document, through a client with no RLS in the path.
    const { client } = stubClient({ data: { user_id: ALICE } });
    await expect(
      deriveOwner(
        client,
        { table: "syllabus_extractions", id: ROW },
        { claimed: BOB, job: "process-document" },
      ),
    ).rejects.toThrow(OwnerMismatchError);
  });

  it("does not silently prefer either side", async () => {
    const { client } = stubClient({ data: { user_id: ALICE } });
    const error = await deriveOwner(
      client,
      { table: "syllabus_extractions", id: ROW },
      { claimed: BOB, job: "process-document" },
    ).catch((e: unknown) => e);

    // Both values appear, so the dashboard entry names the tenant that was targeted and
    // the tenant that was reached. A message with only one of them is not investigable.
    expect(String(error)).toContain(BOB);
    expect(String(error)).toContain(ALICE);
  });

  it("is NonRetriable — the disagreement is identical on every attempt", async () => {
    // Retrying a cross-tenant claim burns the budget re-deciding a question whose answer
    // must stay "no". It is also stored in the event, so nothing about it can change.
    const { client } = stubClient({ data: { user_id: ALICE } });
    await expect(
      deriveOwner(client, { table: "syllabus_extractions", id: ROW }, { claimed: BOB, job: "j" }),
    ).rejects.toBeInstanceOf(NonRetriableError);
  });

  it("logs the mismatch loudly, not only in the thrown message", async () => {
    const { client } = stubClient({ data: { user_id: ALICE } });
    await deriveOwner(
      client,
      { table: "syllabus_extractions", id: ROW },
      { claimed: BOB, job: "process-document" },
    ).catch(() => undefined);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[security]"));
  });

  it("accepts a claim that agrees with the database", async () => {
    const { client } = stubClient({ data: { user_id: ALICE } });
    await expect(
      deriveOwner(client, { table: "syllabus_extractions", id: ROW }, { claimed: ALICE, job: "j" }),
    ).resolves.toMatchObject({ userId: ALICE });
  });

  it("needs no claim at all — the database's answer is complete on its own", async () => {
    const { client } = stubClient({ data: { user_id: ALICE } });
    await expect(
      deriveOwner(client, { table: "syllabus_extractions", id: ROW }, { job: "j" }),
    ).resolves.toMatchObject({ userId: ALICE });
  });
});

describe("failures are sorted into retriable and not", () => {
  it("is NonRetriable when the row does not exist", async () => {
    const { client } = stubClient({ data: null });
    const error = await deriveOwner(
      client,
      { table: "syllabus_extractions", id: ROW },
      { job: "j" },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OwnedRowNotFoundError);
    expect(error).toBeInstanceOf(NonRetriableError);
  });

  it("is RETRIABLE when the read itself failed", async () => {
    // A connection reset says nothing about ownership. Marking it non-retriable would
    // throw away real work over a blip — the opposite mistake from trusting the payload,
    // and just as much a bug.
    const { client } = stubClient({ error: { message: "connection reset" } });
    const error = await deriveOwner(
      client,
      { table: "syllabus_extractions", id: ROW },
      { job: "j" },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NonRetriableError);
    expect(String(error)).toContain("connection reset");
  });

  it("refuses a row whose owner column came back unusable", async () => {
    // Every user-owned table declares user_id not null, so this can only mean the schema
    // and this helper disagree — which must not resolve to "no owner, write anyway".
    const { client } = stubClient({ data: { user_id: null } });
    await expect(
      deriveOwner(client, { table: "syllabus_extractions", id: ROW }, { job: "j" }),
    ).rejects.toThrow(/no usable user_id/);
  });
});

describe("the locator type makes an unowned source unrepresentable", () => {
  it("rejects a table that does not exist, at compile time", async () => {
    const { client } = stubClient({ data: { user_id: ALICE } });
    await expect(
      // @ts-expect-error — `OwnedTable` is computed from the generated Database type, so a
      // name the schema does not have cannot be typed here at all. This is the half of the
      // rule that a code comment cannot enforce: a future handler cannot quietly derive
      // "ownership" from a table that has no owner.
      deriveOwner(client, { table: "not_a_table", id: ROW }, { job: "j" }),
    ).resolves.toBeDefined();
  });

  it("rejects an owned table name that is merely a string", async () => {
    const { client } = stubClient({ data: { user_id: ALICE } });
    const fromConfig: string = "syllabus_extractions";
    await expect(
      // @ts-expect-error — widening to `string` is exactly how a table name reaches this
      // API from an untrusted place. The union has to reject it.
      deriveOwner(client, { table: fromConfig, id: ROW }, { job: "j" }),
    ).resolves.toBeDefined();
  });
});
