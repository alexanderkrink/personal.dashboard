"use client";

import { enqueue } from "@study/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { type LedgerQueue, type LedgerSender, loadQueue, runFlush, saveQueue } from "./local-queue";
import type { LedgerEntry } from "./schemas";

/**
 * The queue's React face: state, localStorage persistence, the online
 * listener. Everything that can lose a tap is in @study/core or local-queue.ts
 * — except two concurrency guards that only exist here, each proven red
 * against a guard-less scaffold first:
 *
 *  1. **One flush in the air at a time, and a request during flight is
 *     COALESCED, never dropped.** Two concurrent sends would replay the same
 *     entries side by side (only the participation PK would stand between
 *     that and a double-logged contribution) — but a plain boolean guard
 *     silently swallows the tap-triggered flush that arrives while the mount
 *     flush is mid-microtask, leaving the tap queued until the next 'online'
 *     event. The red run caught exactly that. So a blocked request sets a
 *     follow-up flag and the in-flight loop runs one more round.
 *  2. **A tap during a flush survives it.** The flush resolves against the
 *     snapshot it sent; the next queue is the snapshot's survivors PLUS
 *     whatever was pushed while the request was in the air.
 */

export interface LedgerQueueApi {
  /** Entries not yet confirmed by the server — the "N queued" badge. */
  pendingCount: number;
  /** Entries the server permanently refused; the user is owed the news. */
  rejected: readonly LedgerEntry[];
  /** Enqueue (idempotent by clientId) and try to flush immediately. */
  push: (entry: LedgerEntry) => void;
  flush: () => Promise<void>;
  dismissRejected: () => void;
}

export function useLedgerQueue(userId: string, sender: LedgerSender): LedgerQueueApi {
  // Starts empty on the server AND the first client render — localStorage is
  // read in the mount effect below, so hydration never sees two answers.
  const [queue, setQueueState] = useState<LedgerQueue>([]);
  const [rejected, setRejected] = useState<readonly LedgerEntry[]>([]);
  const queueRef = useRef(queue);
  const inFlightRef = useRef(false);
  const followUpRef = useRef(false);

  const setQueue = useCallback(
    (next: LedgerQueue) => {
      queueRef.current = next;
      setQueueState(next);
      saveQueue(window.localStorage, userId, next);
    },
    [userId],
  );

  const flush = useCallback(async () => {
    if (inFlightRef.current) {
      // Guard 1: don't send concurrently — but don't forget the request either.
      followUpRef.current = true;
      return;
    }
    inFlightRef.current = true;
    try {
      do {
        followUpRef.current = false;
        const snapshot = queueRef.current;
        const applied = await runFlush(snapshot, sender);

        // Guard 2: entries pushed while the request was in the air are not in
        // `applied` and must not be lost.
        const snapshotIds = new Set(snapshot.map((entry) => entry.clientId));
        const newcomers = queueRef.current.filter((entry) => !snapshotIds.has(entry.clientId));
        setQueue([...applied.queue, ...newcomers]);

        if (applied.rejected.length > 0) {
          setRejected((previous) => [
            ...previous,
            ...applied.rejected.map((entry) => entry.payload),
          ]);
        }
        // One more round only when a request arrived mid-flight — failed
        // entries alone do NOT loop, or a dead network would spin retries.
      } while (followUpRef.current);
    } finally {
      inFlightRef.current = false;
    }
  }, [sender, setQueue]);

  const push = useCallback(
    (entry: LedgerEntry) => {
      const next = enqueue(queueRef.current, entry.clientId, entry);
      if (next !== queueRef.current) setQueue(next);
      void flush();
    },
    [flush, setQueue],
  );

  useEffect(() => {
    // The previous visit may have ended offline with taps still queued. Those
    // leftovers are older than anything tapped in the milliseconds before this
    // effect ran, so they merge in FIRST; `enqueue` keeps the merge idempotent.
    const stored = loadQueue(window.localStorage, userId);
    if (stored.length > 0) {
      let merged = stored;
      for (const entry of queueRef.current) {
        merged = enqueue(merged, entry.clientId, entry.payload);
      }
      setQueue(merged);
    }

    const onOnline = () => void flush();
    window.addEventListener("online", onOnline);
    void flush();
    return () => window.removeEventListener("online", onOnline);
  }, [flush, setQueue, userId]);

  const dismissRejected = useCallback(() => setRejected([]), []);

  return { pendingCount: queue.length, rejected, push, flush, dismissRejected };
}
