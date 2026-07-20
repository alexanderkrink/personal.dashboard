import type { QueueEntry } from "@study/core";
import { describe, expect, it } from "vitest";
import { loadQueue, queueStorageKey, runFlush, saveQueue } from "./local-queue";
import type { LedgerEntry } from "./schemas";

/**
 * The queue's storage and transport edges. The pure state machine
 * (mid-batch failure, duplicate enqueue, partial rejection) is red-tested in
 * @study/core; what lives here is everything that touches the outside world,
 * and each guard was proven red against a trusting scaffold first:
 *
 *  - localStorage content is user-editable input, not our data structure —
 *    corrupt JSON or tampered entries must yield an empty/filtered queue, not
 *    an exception at logging time;
 *  - a sender that THROWS confirmed nothing — the queue must survive intact,
 *    because "the connection died" is the queue's entire reason to exist.
 */

const OCCURRENCE = "8b6f4a1e-0f3d-4a7b-9c2e-5d8e7f6a1b2c";

const entry = (clientId: string): QueueEntry<LedgerEntry> => ({
  clientId,
  payload: {
    type: "participation",
    clientId,
    occurrenceId: OCCURRENCE,
    kind: "comment",
    quality: 3,
  },
  attempts: 0,
});

const CLIENT_A = "1a6f4a1e-0f3d-4a7b-9c2e-5d8e7f6a1b2c";
const CLIENT_B = "2b6f4a1e-0f3d-4a7b-9c2e-5d8e7f6a1b2c";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    dump: () => Object.fromEntries(map),
  };
}

describe("loadQueue — localStorage is untrusted input", () => {
  it("round-trips what saveQueue wrote", () => {
    const storage = memoryStorage();
    saveQueue(storage, "user-1", [entry(CLIENT_A)]);
    expect(loadQueue(storage, "user-1")).toEqual([entry(CLIENT_A)]);
  });

  it("corrupt JSON yields an empty queue, never an exception", () => {
    const storage = memoryStorage({ [queueStorageKey("user-1")]: "{not json" });
    expect(loadQueue(storage, "user-1")).toEqual([]);
  });

  it("a non-array payload yields an empty queue", () => {
    const storage = memoryStorage({ [queueStorageKey("user-1")]: '{"clientId":"x"}' });
    expect(loadQueue(storage, "user-1")).toEqual([]);
  });

  it("tampered entries are dropped; intact ones survive", () => {
    const tampered = [
      entry(CLIENT_A),
      { clientId: CLIENT_B, payload: { type: "participation", kind: "bribery" }, attempts: 0 },
    ];
    const storage = memoryStorage({
      [queueStorageKey("user-1")]: JSON.stringify(tampered),
    });
    expect(loadQueue(storage, "user-1")).toEqual([entry(CLIENT_A)]);
  });

  it("queues are per-user: another user's key is invisible", () => {
    const storage = memoryStorage();
    saveQueue(storage, "user-1", [entry(CLIENT_A)]);
    expect(loadQueue(storage, "user-2")).toEqual([]);
  });

  it("saving an empty queue removes the key instead of storing []", () => {
    const storage = memoryStorage();
    saveQueue(storage, "user-1", [entry(CLIENT_A)]);
    saveQueue(storage, "user-1", []);
    expect(storage.dump()).toEqual({});
  });
});

describe("runFlush — the transport edge", () => {
  it("a sender that throws confirmed NOTHING: the queue survives intact", () => {
    const queue = [entry(CLIENT_A), entry(CLIENT_B)];
    return runFlush(queue, () => Promise.reject(new Error("offline"))).then((applied) => {
      expect(applied.queue).toEqual(queue);
      expect(applied.delivered).toEqual([]);
      expect(applied.rejected).toEqual([]);
    });
  });

  it("an empty queue never calls the sender", async () => {
    let calls = 0;
    const applied = await runFlush([], () => {
      calls += 1;
      return Promise.resolve([]);
    });
    expect(calls).toBe(0);
    expect(applied.queue).toEqual([]);
  });

  it("sender results are applied: delivered leaves, failed stays", async () => {
    const queue = [entry(CLIENT_A), entry(CLIENT_B)];
    const applied = await runFlush(queue, () =>
      Promise.resolve([
        { clientId: CLIENT_A, outcome: "delivered" as const },
        { clientId: CLIENT_B, outcome: "failed" as const },
      ]),
    );
    expect(applied.delivered.map((e) => e.clientId)).toEqual([CLIENT_A]);
    expect(applied.queue.map((e) => e.clientId)).toEqual([CLIENT_B]);
  });
});
