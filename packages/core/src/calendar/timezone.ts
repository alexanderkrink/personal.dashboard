/**
 * Wall-clock ↔ UTC conversion against the platform IANA database.
 *
 * PLAN "Deadlines & Calendar Hub" §3.4 rule 2: a `TZID` that arrives without a
 * `VTIMEZONE` block is resolved through `Intl.DateTimeFormat` — full tz data,
 * zero dependencies, available in every runtime `packages/core` targets
 * (browser, node, edge, WASM).
 *
 * **This is the primary path for the IE feed, not an edge case.** Verified
 * 2026-07-18: the export carries 738 `TZID=Europe/Madrid` references and zero
 * `VTIMEZONE` blocks, so every single timestamp in the live feed lands here.
 *
 * Everything in this module is a pure function of (wall clock, tzid) — no
 * ambient `Date.now()`, no locale dependence (the formatter is pinned to
 * `en-US` with explicit numeric fields), no I/O.
 */

/** A calendar date and time with no zone attached — literally what the ICS text says. */
export interface WallClock {
  year: number;
  /** 1-12, not the 0-11 that `Date` uses. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * A timezone id the platform IANA database does not know.
 *
 * §3.4: "a naked TZID that is not IANA-resolvable must fail loudly to a
 * processing event rather than silently floating". Silently floating is the
 * failure mode that puts a lecture on the wrong hour and never tells anyone,
 * so this is an error type rather than a fallback.
 */
export class UnknownTimezoneError extends Error {
  readonly tzid: string;

  constructor(tzid: string) {
    super(`Unknown IANA timezone: ${tzid}`);
    this.name = "UnknownTimezoneError";
    this.tzid = tzid;
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * A formatter that renders an instant as wall-clock numbers in `tzid`.
 *
 * Cached because `Intl.DateTimeFormat` construction is the expensive part and a
 * 379-event feed converts ~740 timestamps through the same one or two zones.
 * The cache is keyed by tzid and holds only immutable formatters, so it stays
 * safe for concurrent callers.
 */
function formatterFor(tzid: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(tzid);
  if (cached) {
    return cached;
  }

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tzid,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      era: "narrow",
    });
  } catch {
    // RangeError — the platform's tz database has no such zone.
    throw new UnknownTimezoneError(tzid);
  }

  formatterCache.set(tzid, formatter);
  return formatter;
}

/** True when the platform IANA database can resolve `tzid`. Never throws. */
export function isKnownTimezone(tzid: string): boolean {
  try {
    formatterFor(tzid);
    return true;
  } catch {
    return false;
  }
}

/**
 * The wall clock shown in `tzid` at a given UTC instant.
 *
 * `Intl` is the only tz-aware primitive available to a dependency-free package,
 * and `formatToParts` is the only way to read its output without parsing a
 * localized string.
 *
 * Exported because §7's week window is defined in `profiles.timezone` — "which
 * Monday is it *there*" is a question about the local wall clock, and answering
 * it by subtracting a fixed offset from UTC puts the boundary an hour out on
 * DST weekends.
 */
export function wallClockAt(utcMs: number, tzid: string): WallClock {
  const parts = formatterFor(tzid).formatToParts(new Date(utcMs));
  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (!part) {
      throw new Error(`Intl.DateTimeFormat produced no "${type}" part for ${tzid}`);
    }
    return Number(part.value);
  };

  // `era` is requested so a BC instant is detectable rather than silently
  // wrapping; the study calendar never sees one, but a wrong year is exactly
  // the kind of failure that would look like a timezone bug.
  const era = parts.find((part) => part.type === "era")?.value;
  const year = field("year");

  return {
    year: era === "B" ? 1 - year : year,
    month: field("month"),
    day: field("day"),
    hour: field("hour"),
    minute: field("minute"),
    second: field("second"),
  };
}

function wallClockToPseudoUtcMs(wall: WallClock): number {
  // `Date.UTC` treats years 0-99 as 1900+y; the calendar never sees them, but
  // being explicit costs nothing and removes a silent trap.
  const ms = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  if (wall.year >= 0 && wall.year <= 99) {
    const corrected = new Date(ms);
    corrected.setUTCFullYear(wall.year);
    return corrected.getTime();
  }
  return ms;
}

/**
 * The zone's offset from UTC at `utcMs`, in milliseconds (east of UTC positive).
 *
 * Europe/Madrid returns `+3600000` in winter (CET) and `+7200000` in summer
 * (CEST) — the shift that has to land on the right side of 2026-03-29 and
 * 2026-10-25 for a 10:00 class to stay at 10:00 local.
 */
export function timezoneOffsetMs(utcMs: number, tzid: string): number {
  return wallClockToPseudoUtcMs(wallClockAt(utcMs, tzid)) - utcMs;
}

const ONE_DAY_MS = 86_400_000;

/**
 * Converts a wall clock in `tzid` to the UTC instant it denotes.
 *
 * The offset we need is the offset *at the answer*, not at the naive instant,
 * and near a transition those differ. So rather than iterating to a fixed point
 * — which stops early and silently picks whichever reading it happened to land
 * on — this brackets the transition explicitly: sample the offset a day either
 * side, build a candidate from each, and keep the candidates that actually
 * round-trip to the requested wall clock. A day is a safe bracket because no
 * zone changes offset twice within 48 hours.
 *
 * That makes both DST edges deterministic rather than incidental:
 * - **Autumn-back overlap** (02:30 happens twice on 25 Oct 2026): *both*
 *   candidates round-trip, so the **earlier** — the pre-transition, still-DST
 *   reading — wins, matching RFC 5545 and every other calendar client.
 * - **Spring-forward gap** (02:30 never exists on 29 Mar 2026, the clock jumps
 *   02:00→03:00): *neither* candidate round-trips, so the later one wins, which
 *   shifts the time forward past the gap (02:30 → 03:30 local). Never throws —
 *   a feed is allowed to name a time that does not exist, and dropping the
 *   lecture would be a worse answer than moving it an hour.
 *
 * @throws {UnknownTimezoneError} if `tzid` is not in the platform IANA database.
 */
export function wallClockToUtcMs(wall: WallClock, tzid: string): number {
  const naive = wallClockToPseudoUtcMs(wall);

  const offsetBefore = timezoneOffsetMs(naive - ONE_DAY_MS, tzid);
  const offsetAfter = timezoneOffsetMs(naive + ONE_DAY_MS, tzid);

  // Away from a transition both samples agree and there is a single candidate.
  const candidates =
    offsetBefore === offsetAfter
      ? [naive - offsetBefore]
      : [naive - offsetBefore, naive - offsetAfter];

  const roundTrips = candidates.filter(
    (candidate) => timezoneOffsetMs(candidate, tzid) === naive - candidate,
  );

  if (roundTrips.length > 0) {
    return Math.min(...roundTrips);
  }
  return Math.max(...candidates);
}

/** Convenience wrapper returning an ISO 8601 UTC string (`...Z`). */
export function wallClockToUtcIso(wall: WallClock, tzid: string): string {
  return new Date(wallClockToUtcMs(wall, tzid)).toISOString();
}
