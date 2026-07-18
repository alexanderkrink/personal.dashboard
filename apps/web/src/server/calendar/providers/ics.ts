/**
 * `IcsCalendarProvider` — the I/O half of ICS ingestion (§4).
 *
 * The split with `packages/core` is strict and worth restating, because it is
 * the reason this file is so small: **core parses, this fetches.** Core cannot
 * import `node:crypto` or call `fetch` (it has no `@types/node`, and purity is
 * compiler-enforced), so everything here is conditional GET, body hashing and
 * error classification, and the moment there is text it is handed to
 * `parseIcsToNormalizedEvents()`.
 *
 * Two of §3.2's three skip layers live here:
 *   1. HTTP conditional GET — `If-None-Match` / `If-Modified-Since` from the
 *      stored cursor. A 304 ends the run without a body.
 *   2. SHA-256 of the body vs the stored `contentHash`. The ICS endpoint does
 *      not reliably honour conditional headers, so this catches the very common
 *      "200 with a byte-identical body" and skips the parse entirely.
 * Layer 3 (per-row payload diff) belongs to the engine, which is the only thing
 * that can see the stored rows.
 */

import { createHash } from "node:crypto";
import {
  type CalendarProvider,
  err,
  ok,
  type ParseIcsOptions,
  parseIcsToNormalizedEvents,
  type Result,
  type SyncError,
  type SyncInput,
  type SyncOutput,
} from "@study/core";
import { redactSecrets } from "@/lib/calendar/secret";
import { icsFeedConfigSchema } from "../config";

/**
 * What we remember between runs. Persisted verbatim into
 * `calendar_feeds.sync_cursor`; only this provider interprets it.
 */
export interface IcsCursor {
  etag?: string;
  lastModified?: string;
  contentHash?: string;
}

function readCursor(cursor: unknown): IcsCursor {
  if (typeof cursor !== "object" || cursor === null) return {};
  const record = cursor as Record<string, unknown>;
  const result: IcsCursor = {};
  if (typeof record.etag === "string") result.etag = record.etag;
  if (typeof record.lastModified === "string") result.lastModified = record.lastModified;
  if (typeof record.contentHash === "string") result.contentHash = record.contentHash;
  return result;
}

function sha256(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * Maps a response status onto the `SyncError` vocabulary.
 *
 * 401/403 is `unauthorized` rather than a retryable failure on purpose: for a
 * capability URL those two mean the token was revoked or rotated, and retrying
 * a revoked token forever is how a broken feed stays broken silently. The UI
 * surfaces it as "reconnect".
 */
function classifyStatus(status: number): SyncError {
  if (status === 401 || status === 403 || status === 410) return { kind: "unauthorized" };
  return { kind: "unavailable", retryable: true };
}

/** Milliseconds before a feed fetch is abandoned. */
const FETCH_TIMEOUT_MS = 20_000;

export const icsCalendarProvider: CalendarProvider = {
  source: "ics",
  configSchema: icsFeedConfigSchema,

  async sync(input: SyncInput): Promise<Result<SyncOutput, SyncError>> {
    const parsedConfig = icsFeedConfigSchema.safeParse(input.config);
    if (!parsedConfig.success) {
      // No value from the failed parse is echoed: the value is the token.
      return err({ kind: "parse", detail: "Feed configuration is not valid." });
    }
    const { url } = parsedConfig.data;
    const cursor = readCursor(input.cursor);

    const headers: Record<string, string> = {
      accept: "text/calendar, text/plain;q=0.9, */*;q=0.5",
    };
    // §3.2 layer 1.
    if (cursor.etag) headers["if-none-match"] = cursor.etag;
    if (cursor.lastModified) headers["if-modified-since"] = cursor.lastModified;

    let response: Response;
    try {
      response = await fetch(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        // A calendar feed is exactly the thing a cache would serve stale.
        cache: "no-store",
      });
    } catch {
      // The cause is deliberately DROPPED rather than carried along.
      //
      // `SyncError`'s `unavailable` variant has no `detail` field, and network
      // errors are precisely the ones that splice the URL — token and all —
      // into their `message`. Widening the type to carry that string would put
      // a secret one careless `console.error` away from a log file, to buy a
      // reason the user cannot act on anyway ("couldn't reach the feed" is the
      // whole actionable content). If a cause is ever needed here, it has to be
      // run through `redactSecrets` first — hence the import staying put.
      return err({ kind: "unavailable", retryable: true });
    }

    // 304: the server confirmed nothing changed. No body, nothing to parse.
    if (response.status === 304) {
      return ok({ changed: false, cursor });
    }

    if (!response.ok) {
      return err(classifyStatus(response.status));
    }

    let body: string;
    try {
      body = await response.text();
    } catch {
      return err({ kind: "unavailable", retryable: true });
    }

    const contentHash = sha256(body);
    const nextCursor: IcsCursor = { contentHash };
    const etag = response.headers.get("etag");
    const lastModified = response.headers.get("last-modified");
    if (etag) nextCursor.etag = etag;
    if (lastModified) nextCursor.lastModified = lastModified;

    // §3.2 layer 2. The IE endpoint answers 200 with an identical body far more
    // often than it answers 304, so in practice this is the layer that does the
    // work — and it saves the parse, not just the write.
    if (cursor.contentHash && cursor.contentHash === contentHash) {
      return ok({ changed: false, cursor: nextCursor });
    }

    const parseOptions: ParseIcsOptions = {
      defaultTimezone: input.defaultTimezone,
      horizon: input.horizon,
    };
    const knownCourseNames = readKnownCourseNames(input);
    if (knownCourseNames) parseOptions.knownCourseNames = knownCourseNames;

    const parsed = parseIcsToNormalizedEvents(body, parseOptions);
    if (!parsed.ok) {
      // A parse failure DOES carry a detail, and that detail quotes the feed
      // body — which is remote content that can contain URLs of its own. It is
      // shown to the user and stored in `last_sync_error`, so it gets scrubbed
      // on the way past, including for the feed URL itself in case the body
      // echoed it back.
      const detail = parsed.error.kind === "parse" ? redactSecrets(parsed.error.detail, [url]) : "";
      return parsed.error.kind === "parse" ? err({ kind: "parse", detail }) : parsed;
    }

    return ok({ changed: true, cursor: nextCursor, events: parsed.value.events });
  },
};

/**
 * Course titles for kind rule 1b, threaded through `SyncInput.config`.
 *
 * `SyncInput` has no field for them — it is core's type and adding an
 * application-specific one there would push knowledge of our `courses` table
 * into a package that must not have any. The engine attaches them to the config
 * object it passes; the config schema ignores unknown keys, so nothing else
 * notices.
 */
function readKnownCourseNames(input: SyncInput): readonly string[] | null {
  if (typeof input.config !== "object" || input.config === null) return null;
  const value = (input.config as Record<string, unknown>).knownCourseNames;
  if (!Array.isArray(value)) return null;
  const names = value.filter((entry): entry is string => typeof entry === "string");
  return names.length > 0 ? names : null;
}
