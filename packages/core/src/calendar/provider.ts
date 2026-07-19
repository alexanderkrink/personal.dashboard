/**
 * The calendar provider abstraction (§4).
 *
 * The sync engine owns everything stateful — dedup, diffing, tombstones, course
 * matching, persistence. A provider only turns a remote source into normalized
 * events plus a new cursor. Adding another ICS feed, or a future non-ICS
 * source, is therefore a provider add and never an engine rewrite.
 *
 * **Pure types and pure parsing only.** `packages/core` may not fetch, read
 * `process.env`, or touch a Node built-in (CLAUDE.md package boundaries), so the
 * `sync()` implementation — the part that does I/O — lives in
 * `apps/web/src/server/calendar/providers/`. What lives here is the contract it
 * implements and the parser it delegates to.
 */

import type { z } from "zod";
import type { Result } from "../result";
import type { SessionDescriptor } from "./summary";

export type CalendarSource = "ics";

export type CalendarItemKind = "deadline" | "class" | "event";

export type OccurrenceStatus = "confirmed" | "tentative" | "cancelled";

export interface NormalizedOccurrence {
  /** `''` for the sole instance of a non-recurring event. */
  recurrenceId: string;
  /** ISO 8601, always UTC. Timezone math happens here, once, and never in the UI. */
  startsAtUtc: string;
  endsAtUtc?: string;
  allDay: boolean;
  status: OccurrenceStatus;
  /** This instance was individually edited upstream (a `RECURRENCE-ID` override). */
  overridden: boolean;
}

export interface NormalizedEvent {
  uid: string;
  sequence: number;
  kind: CalendarItemKind;
  /** Normalized, course prefix stripped. */
  title: string;
  /** Verbatim `SUMMARY` — lets the normalizer be re-run after a rule fix. */
  rawSummary: string;
  description?: string;
  location?: string;
  rrule?: string;
  originalTzid?: string;
  /**
   * §5.1b session grammar. Undefined for feeds without one. The **engine**, not
   * the provider, computes exam candidacy, since that is a per-course maximum
   * taken ACROSS events and a provider only ever sees one event at a time.
   */
  sessionFrom?: number;
  sessionTo?: number;
  descriptor?: SessionDescriptor;
  occurrences: NormalizedOccurrence[];
  /** Raw course text for the matcher — the first multi-space segment of `SUMMARY`. */
  courseHint?: string;
}

export interface SyncInput {
  /** Provider-specific; validated with the provider's own Zod schema. */
  config: unknown;
  /** Opaque to the engine, which stores and returns it verbatim. */
  cursor: unknown | null;
  horizon: { fromUtc: string; toUtc: string };
  /** `profiles.timezone` — how floating times are interpreted (§3.4 rule 4). */
  defaultTimezone: string;
}

export type SyncOutput =
  | { changed: false; cursor: unknown }
  | {
      changed: true;
      cursor: unknown;
      /** ICS returns the full window every time → the engine runs tombstone diffing. */
      events: NormalizedEvent[];
    };

export type SyncError =
  /** Feed URL/token revoked → surface "reconnect" in the UI. */
  | { kind: "unauthorized" }
  | { kind: "unavailable"; retryable: true }
  | { kind: "parse"; detail: string };

export interface CalendarProvider {
  readonly source: CalendarSource;
  readonly configSchema: z.ZodType<unknown>;
  sync(input: SyncInput): Promise<Result<SyncOutput, SyncError>>;
}
