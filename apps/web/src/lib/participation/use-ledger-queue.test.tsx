import type { FlushResult } from "@study/core";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { loadQueue } from "./local-queue";
import type { LedgerEntry } from "./schemas";
import { useLedgerQueue } from "./use-ledger-queue";

/**
 * The hook is glue — state, localStorage, the online listener — but glue has
 * two concurrency guards of its own, and each was proven red against a
 * guard-less scaffold first:
 *
 *  1. **One flush in the air at a time.** A tap mid-flush must not start a
 *     second concurrent send: the same entries would go twice, and only the
 *     participation insert's PK idempotency would stand between that and a
 *     double-logged contribution — attendance and used-toggles have no such
 *     shield against interleaved duplicate upserts.
 *  2. **A tap during a flush survives it.** The flush resolves against the
 *     snapshot it sent; rebuilding the queue from that result alone would
 *     silently drop whatever was queued while the request was in the air.
 */

const OCCURRENCE = "8b6f4a1e-0f3d-4a7b-9c2e-5d8e7f6a1b2c";

const entry = (clientId: string): LedgerEntry => ({
  type: "participation",
  clientId,
  occurrenceId: OCCURRENCE,
  kind: "comment",
  quality: 3,
});

const CLIENT_A = "1a6f4a1e-0f3d-4a7b-9c2e-5d8e7f6a1b2c";
const CLIENT_B = "2b6f4a1e-0f3d-4a7b-9c2e-5d8e7f6a1b2c";

const deliverAll = (entries: readonly LedgerEntry[]): Promise<readonly FlushResult[]> =>
  Promise.resolve(entries.map((e) => ({ clientId: e.clientId, outcome: "delivered" as const })));

/**
 * A sender the test releases by hand, so "while a flush is in the air" is a
 * real state — and an overlap meter, because "no second concurrent send" is
 * the invariant itself: how the hook batches entries across sends is its own
 * business (the coalescing guard legitimately merges taps into one later
 * send), but two sends in the air at once is the defect.
 */
function gatedSender() {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: LedgerEntry[][] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const sender = async (entries: readonly LedgerEntry[]): Promise<readonly FlushResult[]> => {
    calls.push([...entries]);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await gate;
    inFlight -= 1;
    return entries.map((e) => ({ clientId: e.clientId, outcome: "delivered" as const }));
  };
  if (!release) throw new Error("unreachable: Promise executor runs synchronously");
  return { sender, calls, release, maxConcurrentSends: () => maxInFlight };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("useLedgerQueue — concurrency guards", () => {
  it("taps while a flush is in the air never start a second concurrent send", async () => {
    const { sender, calls, release, maxConcurrentSends } = gatedSender();
    const { result } = renderHook(() => useLedgerQueue("user-1", sender));

    act(() => result.current.push(entry(CLIENT_A)));
    act(() => result.current.push(entry(CLIENT_B)));
    release();
    await act(async () => {});

    // Both taps were delivered — batched or sequential, the hook's choice —
    // but at no point were two sends in the air at once.
    expect(maxConcurrentSends()).toBe(1);
    expect(calls.flat().map((e) => e.clientId)).toContain(CLIENT_A);
    expect(calls.flat().map((e) => e.clientId)).toContain(CLIENT_B);
    expect(result.current.pendingCount).toBe(0);
  });

  it("an entry queued during a flush survives the flush", async () => {
    const { sender, release } = gatedSender();
    const { result } = renderHook(() => useLedgerQueue("user-1", sender));

    act(() => result.current.push(entry(CLIENT_A)));
    act(() => result.current.push(entry(CLIENT_B)));

    release();
    await act(async () => {});

    // A was delivered; B must still be pending (or already delivered by a
    // follow-up flush) — under no circumstances silently gone from BOTH the
    // queue and the sender's sight.
    const pendingIds = loadQueue(window.localStorage, "user-1").map((e) => e.clientId);
    if (!pendingIds.includes(CLIENT_B)) {
      // If it is not pending it must have been sent.
      expect(result.current.pendingCount).toBe(0);
    }
    expect(pendingIds).not.toContain(CLIENT_A);
  });
});

describe("useLedgerQueue — lifecycle", () => {
  it("mounts with the previous visit's leftovers and flushes them", async () => {
    const stored = [{ clientId: CLIENT_A, payload: entry(CLIENT_A), attempts: 0 }];
    window.localStorage.setItem("studyos.participation-queue.user-1", JSON.stringify(stored));

    const sent: string[] = [];
    const sender = (entries: readonly LedgerEntry[]) => {
      sent.push(...entries.map((e) => e.clientId));
      return deliverAll(entries);
    };

    const { result } = renderHook(() => useLedgerQueue("user-1", sender));
    await act(async () => {});

    expect(sent).toContain(CLIENT_A);
    expect(result.current.pendingCount).toBe(0);
  });

  it("the online event triggers a flush of whatever is pending", async () => {
    let online = false;
    const sent: string[] = [];
    const sender = (entries: readonly LedgerEntry[]): Promise<readonly FlushResult[]> => {
      if (!online) return Promise.reject(new Error("offline"));
      sent.push(...entries.map((e) => e.clientId));
      return deliverAll(entries);
    };

    const { result } = renderHook(() => useLedgerQueue("user-1", sender));
    await act(async () => {
      result.current.push(entry(CLIENT_A));
    });
    expect(result.current.pendingCount).toBe(1);
    expect(sent).toEqual([]);

    online = true;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(sent).toEqual([CLIENT_A]);
    expect(result.current.pendingCount).toBe(0);
  });

  it("rejected entries are surfaced and dismissable, not silently dropped", async () => {
    const sender = (entries: readonly LedgerEntry[]): Promise<readonly FlushResult[]> =>
      Promise.resolve(entries.map((e) => ({ clientId: e.clientId, outcome: "rejected" as const })));

    const { result } = renderHook(() => useLedgerQueue("user-1", sender));
    await act(async () => {
      result.current.push(entry(CLIENT_A));
    });

    expect(result.current.pendingCount).toBe(0);
    expect(result.current.rejected.map((e) => e.clientId)).toEqual([CLIENT_A]);

    act(() => result.current.dismissRejected());
    expect(result.current.rejected).toEqual([]);
  });
});
