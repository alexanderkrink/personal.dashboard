/**
 * The offline logging queue's pure half.
 *
 * The two-tap logger must survive flaky campus wifi, and the queue is the
 * mechanism: every tap is enqueued with a client-generated id, flushed when
 * the network cooperates, and every flush outcome is applied HERE, where the
 * logic is falsifiable. The browser wrapper in apps/web owns localStorage and
 * the online/offline events and nothing else — nothing that can lose a tap
 * lives outside this file.
 *
 * `clientId` is the identity end to end: it is generated at tap time, doubles
 * as the database primary key for inserts, and makes retries idempotent — a
 * flush that half-succeeded before the connection died can be replayed
 * wholesale, and the server's duplicate-key path reports the survivor as
 * delivered rather than logging it twice.
 *
 * Pure by construction: no I/O, no storage, no clock, no environment.
 */

export interface QueueEntry<T> {
  /** Client-generated identity; for inserts it is also the DB primary key. */
  readonly clientId: string;
  readonly payload: T;
  /** Flush attempts that reached the sender and came back `failed`. */
  readonly attempts: number;
}

export type FlushOutcome =
  /** The server confirmed the write (including "already had it"). */
  | "delivered"
  /** The server understood and said no — retrying can never succeed. */
  | "rejected"
  /** Transport-level failure — retrying is the point of the queue. */
  | "failed";

export interface FlushResult {
  readonly clientId: string;
  readonly outcome: FlushOutcome;
}

export interface FlushApplication<T> {
  /** What is still owed to the server: failed entries plus never-reached ones. */
  readonly queue: readonly QueueEntry<T>[];
  readonly delivered: readonly QueueEntry<T>[];
  /**
   * Rejected entries leave the queue — retrying them forever would wedge every
   * entry behind them — but they are returned, not swallowed: the caller owes
   * the user the news that a tap did not count.
   */
  readonly rejected: readonly QueueEntry<T>[];
}

/**
 * Append an entry unless its clientId is already queued — the first write
 * wins, so a nervous double-tap or a retry re-enqueue stays ONE contribution.
 */
export function enqueue<T>(
  queue: readonly QueueEntry<T>[],
  clientId: string,
  payload: T,
): readonly QueueEntry<T>[] {
  if (queue.some((entry) => entry.clientId === clientId)) return queue;
  return [...queue, { clientId, payload, attempts: 0 }];
}

/**
 * Fold a flush's per-entry results back into the queue.
 *
 * An entry with no result was never reached (the flush died mid-batch): it
 * stays queued, attempts untouched. Results naming unknown clientIds are
 * ignored — a stale or duplicated response must not invent queue state.
 */
export function applyFlushResults<T>(
  queue: readonly QueueEntry<T>[],
  results: readonly FlushResult[],
): FlushApplication<T> {
  const outcomes = new Map<string, FlushOutcome>();
  for (const result of results) outcomes.set(result.clientId, result.outcome);

  const remaining: QueueEntry<T>[] = [];
  const delivered: QueueEntry<T>[] = [];
  const rejected: QueueEntry<T>[] = [];

  for (const entry of queue) {
    const outcome = outcomes.get(entry.clientId);
    if (outcome === "delivered") {
      delivered.push(entry);
    } else if (outcome === "rejected") {
      rejected.push(entry);
    } else if (outcome === "failed") {
      remaining.push({ ...entry, attempts: entry.attempts + 1 });
    } else {
      remaining.push(entry);
    }
  }

  return { queue: remaining, delivered, rejected };
}
