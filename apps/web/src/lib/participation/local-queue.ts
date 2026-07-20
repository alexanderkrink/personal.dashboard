import {
  applyFlushResults,
  type FlushApplication,
  type FlushResult,
  type QueueEntry,
} from "@study/core";
import { z } from "zod";
import { type LedgerEntry, ledgerEntrySchema } from "./schemas";

/**
 * The queue's storage and transport edges. The pure state machine — what
 * survives a mid-batch failure, duplicate enqueues, partial rejection — lives
 * in @study/core where it is falsifiable; this module owns exactly two
 * outside-world facts:
 *
 *  1. **localStorage is untrusted input.** It is user-editable storage on a
 *     shared machine and it survives app deploys, so everything read back is
 *     Zod-validated entry by entry: corrupt JSON or a tampered entry costs
 *     that entry, never an exception at logging time — an exception here would
 *     take the two-tap logger down with it.
 *  2. **A sender that throws confirmed nothing.** The connection dying
 *     mid-flush is the queue's entire reason to exist, so a throw applies an
 *     empty result set: every entry stays, attempts untouched.
 */

export type LedgerQueue = readonly QueueEntry<LedgerEntry>[];

const STORAGE_PREFIX = "studyos.participation-queue.";

/** Keyed per user: a shared machine must never flush one account's taps as another's. */
export function queueStorageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

const storedEntrySchema = z.object({
  clientId: z.uuid(),
  payload: ledgerEntrySchema,
  attempts: z.int().nonnegative(),
});

export function loadQueue(storage: Pick<Storage, "getItem">, userId: string): LedgerQueue {
  const raw = storage.getItem(queueStorageKey(userId));
  if (raw === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const entries: QueueEntry<LedgerEntry>[] = [];
  for (const item of parsed) {
    const entry = storedEntrySchema.safeParse(item);
    if (entry.success) entries.push(entry.data);
  }
  return entries;
}

export function saveQueue(
  storage: Pick<Storage, "setItem" | "removeItem">,
  userId: string,
  queue: LedgerQueue,
): void {
  // An empty queue removes the key: "nothing pending" should read as nothing,
  // and localStorage quota is somebody's real phone.
  if (queue.length === 0) {
    storage.removeItem(queueStorageKey(userId));
    return;
  }
  storage.setItem(queueStorageKey(userId), JSON.stringify(queue));
}

export type LedgerSender = (entries: readonly LedgerEntry[]) => Promise<readonly FlushResult[]>;

export async function runFlush(
  queue: LedgerQueue,
  sender: LedgerSender,
): Promise<FlushApplication<LedgerEntry>> {
  if (queue.length === 0) return { queue, delivered: [], rejected: [] };

  let results: readonly FlushResult[];
  try {
    results = await sender(queue.map((entry) => entry.payload));
  } catch {
    // The sender never answered — offline, server unreachable, action aborted.
    // Nothing was confirmed either way, so nothing may leave the queue.
    results = [];
  }
  return applyFlushResults(queue, results);
}
