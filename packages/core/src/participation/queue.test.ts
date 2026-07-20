import { describe, expect, it } from "vitest";
import { applyFlushResults, enqueue, type QueueEntry } from "./queue";

/**
 * The offline logging queue's pure half. The browser wrapper (localStorage,
 * online/offline events, the Server Action call) lives in apps/web; everything
 * that can lose a tap lives here, where it is falsifiable.
 *
 * The three failure shapes named in the item-9 brief are each pinned red
 * before the implementation landed:
 *   1. the flush dies mid-batch,
 *   2. the same entry is queued twice (a nervous double-tap or a retry),
 *   3. the server rejects one entry of several.
 */

type Payload = { kind: string };

const entry = (clientId: string, attempts = 0): QueueEntry<Payload> => ({
  clientId,
  payload: { kind: "comment" },
  attempts,
});

describe("enqueue — idempotency", () => {
  it("queuing the same clientId twice keeps ONE entry, the first", () => {
    // The retry path re-enqueues whatever it still holds; a plain append turns
    // one tap into two graded contributions.
    let queue = enqueue<Payload>([], "a", { kind: "comment" });
    queue = enqueue(queue, "a", { kind: "cold_call" });
    expect(queue).toHaveLength(1);
    expect(queue[0]?.payload.kind).toBe("comment");
  });

  it("distinct clientIds append in order", () => {
    let queue = enqueue<Payload>([], "a", { kind: "comment" });
    queue = enqueue(queue, "b", { kind: "question" });
    expect(queue.map((e) => e.clientId)).toEqual(["a", "b"]);
  });
});

describe("applyFlushResults — mid-batch failure", () => {
  it("keeps everything at and after the failure point; only delivered entries leave", () => {
    const queue = [entry("a"), entry("b"), entry("c")];
    // The sender got through "a", died on "b", never reached "c".
    const applied = applyFlushResults(queue, [
      { clientId: "a", outcome: "delivered" },
      { clientId: "b", outcome: "failed" },
    ]);
    expect(applied.queue.map((e) => e.clientId)).toEqual(["b", "c"]);
    expect(applied.delivered.map((e) => e.clientId)).toEqual(["a"]);
    expect(applied.rejected).toEqual([]);
  });

  it("a failed entry records the attempt; an unreached entry does not", () => {
    const queue = [entry("a"), entry("b")];
    const applied = applyFlushResults(queue, [{ clientId: "a", outcome: "failed" }]);
    expect(applied.queue[0]?.attempts).toBe(1);
    expect(applied.queue[1]?.attempts).toBe(0);
  });

  it("a flush that reports nothing changes nothing", () => {
    const queue = [entry("a"), entry("b")];
    const applied = applyFlushResults(queue, []);
    expect(applied.queue).toEqual(queue);
    expect(applied.delivered).toEqual([]);
    expect(applied.rejected).toEqual([]);
  });
});

describe("applyFlushResults — partial rejection", () => {
  it("a rejected entry leaves the queue AND is surfaced; the rest deliver", () => {
    // Retrying a rejection forever wedges the queue behind an entry the server
    // will never take; dropping it silently loses a tap without telling anyone.
    // It must leave the queue and come back to the caller.
    const queue = [entry("a"), entry("b"), entry("c")];
    const applied = applyFlushResults(queue, [
      { clientId: "a", outcome: "delivered" },
      { clientId: "b", outcome: "rejected" },
      { clientId: "c", outcome: "delivered" },
    ]);
    expect(applied.queue).toEqual([]);
    expect(applied.delivered.map((e) => e.clientId)).toEqual(["a", "c"]);
    expect(applied.rejected.map((e) => e.clientId)).toEqual(["b"]);
  });

  it("results naming clientIds not in the queue are ignored", () => {
    const queue = [entry("a")];
    const applied = applyFlushResults(queue, [
      { clientId: "ghost", outcome: "delivered" },
      { clientId: "a", outcome: "delivered" },
    ]);
    expect(applied.queue).toEqual([]);
    expect(applied.delivered.map((e) => e.clientId)).toEqual(["a"]);
  });
});
