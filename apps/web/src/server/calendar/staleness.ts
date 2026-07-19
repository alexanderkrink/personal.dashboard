/**
 * On-demand, stale-while-revalidate sync (§3.1 step 1).
 *
 * When a page renders and any active feed was last synced more than 30 minutes
 * ago, the page renders **immediately from the database** and schedules the
 * refresh through Next 16's `after()`. The user never waits on an HTTP fetch of
 * a university calendar; the next render has the fresh data.
 *
 * ## 🚨 Why staleness keys on `last_synced_at` and NOT on "did anything change"
 *
 * §3.2 gives the sync three skip layers — `ETag`, `Last-Modified`, and a body
 * hash. **All three are unreliable on this feed**, measured 2026-07-18 against
 * the live endpoint:
 *
 * - it sends **no `ETag` at all**;
 * - its `Last-Modified` is **always the current time**, so a conditional GET
 *   never returns 304;
 * - and the body is **byte-unstable** — `DTSTAMP` is re-stamped on every
 *   regeneration, so the content hash differs even when no event did.
 *
 * The consequence is specific and easy to get wrong: **a sync of this feed
 * essentially never reports `unchanged`.** Any staleness rule phrased as "sync
 * again once the provider tells us nothing changed" would therefore re-sync on
 * every single render, hammering the university endpoint and doing 374 rows of
 * diffing each time. So the clock is the authority here, and the skip layers are
 * treated as an optimisation that may never fire.
 *
 * Everything below is pure and takes `now` as a parameter; the `after()` wiring
 * lives at the call site, where the request-scoped Supabase client does.
 */

/** §3.1: "older than 30 minutes" is stale. */
export const STALE_AFTER_MS = 30 * 60 * 1000;

/** §3.1: the manual "Sync now" button is rate-limited to 1/min per user. */
export const SYNC_RATE_LIMIT_MS = 60 * 1000;

export interface FeedFreshness {
  id: string;
  active: boolean;
  last_synced_at: string | null;
}

/**
 * The active feeds due for a background refresh.
 *
 * A feed that has never synced (`last_synced_at === null`) is stale by
 * definition — that is a freshly added feed, and it is the one moment the user
 * is most obviously waiting for data to appear.
 */
export function selectStaleFeeds(
  feeds: readonly FeedFreshness[],
  now: Date,
  staleAfterMs: number = STALE_AFTER_MS,
): string[] {
  const nowMs = now.getTime();
  return feeds
    .filter((feed) => {
      if (!feed.active) return false;
      if (feed.last_synced_at === null) return true;
      return nowMs - Date.parse(feed.last_synced_at) >= staleAfterMs;
    })
    .map((feed) => feed.id);
}

/** Milliseconds until this feed may be manually synced again; 0 when it may now. */
export function rateLimitRemainingMs(
  lastSyncedAt: string | null,
  now: Date,
  windowMs: number = SYNC_RATE_LIMIT_MS,
): number {
  if (lastSyncedAt === null) return 0;
  const elapsed = now.getTime() - Date.parse(lastSyncedAt);
  if (Number.isNaN(elapsed)) return 0;
  return elapsed >= windowMs ? 0 : windowMs - elapsed;
}

/**
 * Whether a manual sync must be refused right now.
 *
 * The limiter's state is `calendar_feeds.last_synced_at` — a column that already
 * exists, is already written by every run, and is already per-user by RLS. A
 * dedicated counter table or an in-memory map would both be worse: the table is
 * state to maintain for one button, and the map does not survive the next
 * serverless invocation, which is to say it does not limit anything at all.
 *
 * The engine's lease (§3.1) stops two *simultaneous* runs; this stops a
 * hundred sequential ones a second apart.
 */
export function isManualSyncRateLimited(lastSyncedAt: string | null, now: Date): boolean {
  return rateLimitRemainingMs(lastSyncedAt, now) > 0;
}

/** "in 34 s" — the wait, rounded up, for the refusal message. */
export function formatRetryAfter(remainingMs: number): string {
  return `${Math.max(1, Math.ceil(remainingMs / 1000))}s`;
}
