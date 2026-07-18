/**
 * `parseIcsToNormalizedEvents()` — ICS text in, `NormalizedEvent[]` out.
 *
 * The pure half of `IcsCalendarProvider` (§4): ical.js parse → timezone
 * resolution (§3.4) → horizon expansion (§3.5) → summary normalization (§5.1b)
 * → kind classification. The provider in `apps/web` does the fetching, the
 * conditional GET and the body hashing; none of that may live here.
 *
 * Chosen library: **ical.js 2.2.1** (§3.7) — pure JS, zero runtime deps, and
 * timezone-aware recurrence expansion. The `rrule` package was disqualified for
 * computing in UTC, which breaks a Madrid schedule across DST.
 */

import ICAL from "ical.js";
import { err, ok, type Result } from "../result";
import { classifyKind } from "./kind";
import type {
  NormalizedEvent,
  NormalizedOccurrence,
  OccurrenceStatus,
  SyncError,
} from "./provider";
import { normalizeSummary } from "./summary";
import { isKnownTimezone, type WallClock, wallClockToUtcMs } from "./timezone";

export interface ParseIcsOptions {
  /** `profiles.timezone` — how floating times are interpreted (§3.4 rule 4). */
  defaultTimezone: string;
  /**
   * Expansion window for recurring events (§3.5: −30 days to +180 days). Bare
   * (non-recurring) events are returned regardless of the horizon; the engine's
   * queries do the windowing for those, and clipping them here would make an
   * event vanish rather than merely fall outside the current view.
   */
  horizon?: { fromUtc: string; toUtc: string };
  /**
   * Known course names, lowercased comparison, for kind rule 1b. Optional: the
   * caller supplies `courses.title` so a tokenless course row still classifies
   * as a `class` rather than falling through to `event`.
   */
  knownCourseNames?: readonly string[];
  /** Hard ceiling on instances produced per recurring event. */
  maxOccurrencesPerEvent?: number;
}

const DEFAULT_MAX_OCCURRENCES = 750;

export interface ParseIcsResult {
  events: NormalizedEvent[];
  /**
   * Rows dropped as pseudo/LMS noise (§5.1b) — surfaced rather than silently
   * discarded so a sync report can show what the filter ate. Exactly 5 in the
   * verified IE export.
   */
  droppedPseudoRows: string[];
}

/**
 * Reads an `ICAL.Time`'s wall-clock fields.
 *
 * Deliberately reads the *components* rather than calling `toJSDate()`. For a
 * naked TZID ical.js has no zone registered and treats the value as floating,
 * so `toJSDate()` would silently interpret it in the host's local zone — the
 * exact silent-float failure §3.4 forbids. The components, by contrast, are
 * just what the ICS text said, which is precisely what we want to hand to the
 * IANA resolver.
 */
function wallClockOf(time: ICAL.Time): WallClock {
  return {
    year: time.year,
    month: time.month,
    day: time.day,
    hour: time.hour,
    minute: time.minute,
    second: time.second,
  };
}

/**
 * The TZID a property carries, or `null` for UTC and floating values.
 *
 * Three shapes, per §3.4:
 * - `DTSTART;TZID=Europe/Madrid:...` → the tzid (the IE feed's only shape)
 * - `DTSTART:...Z`                   → UTC, passes through (rule 3)
 * - `DTSTART:...` (naked)            → floating, caller's default (rule 4)
 */
function tzidOf(property: ICAL.Property): string | null {
  const tzid = property.getParameter("tzid");
  return typeof tzid === "string" && tzid.length > 0 ? tzid : null;
}

/**
 * Narrows a jCal property value to an `ICAL.Time`.
 *
 * ical.js 2.x types `getFirstValue()` as the full decorated-value union
 * (`Time | Duration | Recur | Period | Binary | UtcOffset | Geo | string |
 * null`) and it takes **no type parameter** — the `getFirstValue<ICAL.Time>()`
 * form does not exist and does not compile. Narrowing with `instanceof` is the
 * supported way to get a `Time` back, and it turns a malformed `DTSTART` into a
 * reportable `SyncError` instead of a cast that explodes at runtime.
 */
function asTime(value: unknown): ICAL.Time | null {
  return value instanceof ICAL.Time ? value : null;
}

/**
 * A date-only jCal value, in either the legal or the IE feed's broken shape.
 *
 * `2026-01-20`     — an RFC 5545 `VALUE=DATE` value, decoded normally.
 * `2026-01-20T::`  — what ical.js produces for a **date-only value carrying a
 *                    `TZID` but no `VALUE=DATE` parameter**.
 */
const DATE_ONLY_JCAL_VALUE = /^(\d{4}-\d{2}-\d{2})(?:T::)?$/;

/**
 * Reads an `ICAL.Time` from a property, repairing the IE feed's all-day shape.
 *
 * 🔴 **This is a real crash, not a theoretical one.** `DTSTART;TZID=Europe/Madrid:20260120`
 * carries no `VALUE=DATE`, so ical.js's design layer types the property
 * `date-time`, emits the malformed jCal value `"2026-01-20T::"`, and then
 * **throws `invalid date-time value`** the moment anything decodes it. Verified
 * 2026-07-18: the real export contains **20** rows in exactly this shape (20
 * `DURATION:P1D`, 20 date-only `DTSTART` with a TZID, and zero `VALUE=DATE`
 * anywhere in the file), so a parser that does not repair it fails the whole
 * feed rather than mishandling one event.
 *
 * Reading the raw jCal value *before* decoding is the only place the repair can
 * happen — by the time `getFirstValue()` has been called it has already thrown.
 */
function readTime(property: ICAL.Property): ICAL.Time | null {
  const raw: unknown = property.jCal[3];
  if (typeof raw === "string") {
    const dateOnly = DATE_ONLY_JCAL_VALUE.exec(raw);
    if (dateOnly?.[1]) {
      // `fromDateString` yields a Time with `isDate = true`, which is what the
      // all-day detection downstream keys on.
      return ICAL.Time.fromDateString(dateOnly[1]);
    }
  }
  return asTime(property.getFirstValue());
}

/**
 * Resolves one ICS date-time to a UTC instant.
 *
 * The resolution order is where §3.4 lives:
 * 1. `...Z` → already UTC, pass through.
 * 2. A TZID that the platform IANA database knows → resolve through `Intl`.
 *    **This is the primary path for the IE feed** (738 naked TZIDs, zero
 *    VTIMEZONE blocks), not a fallback.
 * 3. A TZID with a `VTIMEZONE` registered for this parse → let ical.js do it.
 * 4. A TZID that is neither → **fail loudly**. Never silently float.
 * 5. No TZID → floating, interpreted in `defaultTimezone`.
 */
function resolveToUtcMs(
  time: ICAL.Time,
  tzid: string | null,
  defaultTimezone: string,
  registeredZones: ReadonlySet<string>,
): Result<number, SyncError> {
  const wall = wallClockOf(time);

  // §3.4 rule 3 — a `...Z` value is already UTC and passes straight through.
  // ical.js sets `zone` to its UTC singleton for those. (`ICAL.Time` has no
  // `isUTC()` method in 2.x; the earlier `time.isUTC?.()` guard did not compile
  // and, being optional-called, would have silently evaluated to `undefined`
  // even if it had.)
  if (time.zone === ICAL.Timezone.utcTimezone) {
    return ok(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second));
  }

  const zone = tzid ?? defaultTimezone;

  if (isKnownTimezone(zone)) {
    return ok(wallClockToUtcMs(wall, zone));
  }

  // The zone is not IANA-resolvable. A VTIMEZONE from this feed is the only
  // remaining authority — some feeds ship proprietary ids like
  // `Customized Time Zone` with a real definition attached.
  if (tzid !== null && registeredZones.has(tzid)) {
    const registered = ICAL.TimezoneService.get(tzid);
    if (registered) {
      const converted = time.convertToZone(registered);
      return ok(converted.toJSDate().getTime());
    }
  }

  return err({
    kind: "parse",
    detail: `Unresolvable TZID "${zone}": not an IANA timezone and no VTIMEZONE in the feed`,
  });
}

function statusOf(component: ICAL.Component): OccurrenceStatus {
  const raw = component.getFirstPropertyValue("status");
  const status = typeof raw === "string" ? raw.toLowerCase() : "";
  if (status === "cancelled") {
    return "cancelled";
  }
  if (status === "tentative") {
    return "tentative";
  }
  return "confirmed";
}

/**
 * True when a DTSTART denotes a whole day rather than an instant.
 *
 * Two shapes, and the IE feed uses the *undocumented* one:
 * - `DTSTART;VALUE=DATE:20260120` — the RFC 5545 form.
 * - `DTSTART;TZID=Europe/Madrid:20260120` with `DURATION:P1D` — a date-only
 *   value with **no `VALUE=DATE` parameter at all**. ⚠ Verified 2026-07-18:
 *   20 events in the real export use this shape and none carry `VALUE=DATE`.
 *   Testing only for the parameter would time-shift all 20 to midnight-as-an-
 *   instant, so the length of the value is the reliable signal.
 */
function isAllDay(property: ICAL.Property, time: ICAL.Time): boolean {
  // `getParameter` returns `string | string[]` — a bare `=== "DATE"` silently
  // misses the (legal) multi-valued form.
  const value = property.getParameter("value");
  const values = Array.isArray(value) ? value : [value];
  if (values.some((entry) => typeof entry === "string" && entry.toUpperCase() === "DATE")) {
    return true;
  }
  return time.isDate === true;
}

function toIsoUtc(ms: number): string {
  return new Date(ms).toISOString();
}

interface OccurrenceContext {
  defaultTimezone: string;
  registeredZones: ReadonlySet<string>;
}

/** Builds one occurrence from a concrete start (and optional end) wall clock. */
function buildOccurrence(
  recurrenceId: string,
  start: ICAL.Time,
  end: ICAL.Time | null,
  startTzid: string | null,
  endTzid: string | null,
  allDay: boolean,
  status: OccurrenceStatus,
  overridden: boolean,
  context: OccurrenceContext,
): Result<NormalizedOccurrence, SyncError> {
  // §3.4 rule 5 — an all-day event is anchored to midnight in the **profile**
  // timezone, so any TZID on the property is deliberately ignored. RFC 5545
  // agrees: a `DATE` value must not carry a TZID at all, and the one the IE feed
  // attaches is meaningless. Honouring it would re-anchor the day in Madrid for
  // a user reading from another zone, which is exactly the midnight drift the
  // rule exists to prevent ("views render them as dates, never times").
  const effectiveStartTzid = allDay ? null : startTzid;
  const effectiveEndTzid = allDay ? null : endTzid;

  const startMs = resolveToUtcMs(
    start,
    effectiveStartTzid,
    context.defaultTimezone,
    context.registeredZones,
  );
  if (!startMs.ok) {
    return startMs;
  }

  const occurrence: NormalizedOccurrence = {
    recurrenceId,
    startsAtUtc: toIsoUtc(startMs.value),
    allDay,
    status,
    overridden,
  };

  if (end) {
    const endMs = resolveToUtcMs(
      end,
      effectiveEndTzid,
      context.defaultTimezone,
      context.registeredZones,
    );
    if (!endMs.ok) {
      return endMs;
    }
    occurrence.endsAtUtc = toIsoUtc(endMs.value);
  }

  return ok(occurrence);
}

/**
 * Parses an ICS document into normalized events.
 *
 * Returns a `Result` rather than throwing: an unresolvable timezone or a
 * malformed body is an expected, reportable feed condition (`SyncError`), not a
 * programming error. The engine surfaces it as a failed sync with the feed
 * labelled, which is what §3.4's "fail loudly" asks for.
 */
export function parseIcsToNormalizedEvents(
  icsText: string,
  options: ParseIcsOptions,
): Result<ParseIcsResult, SyncError> {
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(icsText));
  } catch (cause) {
    return err({
      kind: "parse",
      detail: `Malformed ICS: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }

  // §3.4 rule 2: register every VTIMEZONE the feed ships. ical.js carries no tz
  // data and registers nothing automatically. The IE feed has zero of these —
  // which is exactly why the IANA path above is the primary one — but a feed
  // that does ship them must be honoured.
  const registeredZones = new Set<string>();
  for (const vtimezone of root.getAllSubcomponents("vtimezone")) {
    const timezone = new ICAL.Timezone(vtimezone);
    if (timezone.tzid) {
      // `register(timezone)` — the name defaults to the zone's own TZID. The
      // `register(tzid, timezone)` argument order is the ical.js **1.x** form;
      // 2.x keeps a runtime shim for it but the typings do not, so the old call
      // failed typecheck.
      ICAL.TimezoneService.register(timezone);
      registeredZones.add(timezone.tzid);
    }
  }

  try {
    return parseEvents(root, options, registeredZones);
  } catch (cause) {
    // ical.js throws from deep inside its decoders on values it considers
    // malformed (the all-day shape above was one such case). The engine's
    // contract is a `Result`, and one bad row must degrade to a reportable
    // failed sync rather than an unhandled exception in a cron job.
    return err({
      kind: "parse",
      detail: `ICS decode failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  } finally {
    // The registry is global to ical.js, so scope it to this parse or one feed's
    // proprietary zone definition leaks into the next feed's resolution.
    for (const tzid of registeredZones) {
      ICAL.TimezoneService.remove(tzid);
    }
  }
}

function parseEvents(
  root: ICAL.Component,
  options: ParseIcsOptions,
  registeredZones: ReadonlySet<string>,
): Result<ParseIcsResult, SyncError> {
  const context: OccurrenceContext = {
    defaultTimezone: options.defaultTimezone,
    registeredZones,
  };
  const maxOccurrences = options.maxOccurrencesPerEvent ?? DEFAULT_MAX_OCCURRENCES;

  const vevents = root.getAllSubcomponents("vevent");

  // `RECURRENCE-ID` overrides are separate VEVENTs sharing the master's UID.
  // Collect them first so the master's expansion can substitute them in.
  const overridesByUid = new Map<string, Map<string, ICAL.Component>>();
  const masters: ICAL.Component[] = [];
  for (const vevent of vevents) {
    const recurrenceIdProperty = vevent.getFirstProperty("recurrence-id");
    const uid = vevent.getFirstPropertyValue("uid");
    const recurrenceIdTime = recurrenceIdProperty ? readTime(recurrenceIdProperty) : null;
    if (recurrenceIdTime && typeof uid === "string") {
      const key = recurrenceIdTime.toString();
      const existing = overridesByUid.get(uid) ?? new Map<string, ICAL.Component>();
      existing.set(key, vevent);
      overridesByUid.set(uid, existing);
    } else {
      masters.push(vevent);
    }
  }

  const events: NormalizedEvent[] = [];
  const droppedPseudoRows: string[] = [];

  for (const vevent of masters) {
    const rawSummary = readString(vevent, "summary") ?? "";

    // §5.1b pseudo/LMS filter. Keyed on each row's own signature, never on the
    // course prefix — two of the five carry a real one.
    const normalized = normalizeSummary(rawSummary);
    if (!normalized) {
      droppedPseudoRows.push(rawSummary);
      continue;
    }

    const built = buildEvent(vevent, normalized.rawSummary, options, context, maxOccurrences, {
      overrides: overridesByUid.get(readString(vevent, "uid") ?? "") ?? new Map(),
    });
    if (!built.ok) {
      return built;
    }
    events.push(built.value);
  }

  return ok({ events, droppedPseudoRows });
}

function readString(component: ICAL.Component, name: string): string | undefined {
  const value = component.getFirstPropertyValue(name);
  return typeof value === "string" ? value : undefined;
}

function buildEvent(
  vevent: ICAL.Component,
  rawSummary: string,
  options: ParseIcsOptions,
  context: OccurrenceContext,
  maxOccurrences: number,
  extras: { overrides: Map<string, ICAL.Component> },
): Result<NormalizedEvent, SyncError> {
  const normalized = normalizeSummary(rawSummary);
  if (!normalized) {
    return err({ kind: "parse", detail: `Pseudo row reached buildEvent: ${rawSummary}` });
  }

  const uid = readString(vevent, "uid") ?? "";
  const sequenceRaw = vevent.getFirstPropertyValue("sequence");
  const sequence = typeof sequenceRaw === "number" ? sequenceRaw : 0;

  const dtstartProperty = vevent.getFirstProperty("dtstart");
  if (!dtstartProperty) {
    return err({ kind: "parse", detail: `VEVENT ${uid} has no DTSTART` });
  }
  const dtstart = readTime(dtstartProperty);
  if (!dtstart) {
    return err({ kind: "parse", detail: `VEVENT ${uid} has a non-date DTSTART` });
  }
  const startTzid = tzidOf(dtstartProperty);

  const dtendProperty = vevent.getFirstProperty("dtend");
  const dtend = dtendProperty ? readTime(dtendProperty) : null;
  const endTzid = dtendProperty ? tzidOf(dtendProperty) : null;

  // `DURATION` is the other way to express an end, and the IE feed's 20 all-day
  // rows use it exclusively (`DURATION:P1D`).
  const durationValue = vevent.getFirstPropertyValue("duration");
  const duration = durationValue instanceof ICAL.Duration ? durationValue : null;

  const allDay = isAllDay(dtstartProperty, dtstart);
  const status = statusOf(vevent);
  // `RRULE` decodes to an `ICAL.Recur`, never a string, so `readString` alone
  // always missed it. `.toString()` gives the raw rule back, which is what
  // `calendar_items.rrule` stores so the horizon can be re-expanded without
  // refetching (§3.5).
  const rruleValue = vevent.getFirstProperty("rrule")?.getFirstValue();
  const rrule =
    rruleValue == null
      ? undefined
      : typeof rruleValue === "string"
        ? rruleValue
        : rruleValue.toString();

  const effectiveEnd = (start: ICAL.Time): ICAL.Time | null => {
    if (dtend) {
      return dtend;
    }
    if (duration) {
      const end = start.clone();
      end.addDuration(duration);
      return end;
    }
    return null;
  };

  const occurrences: NormalizedOccurrence[] = [];

  if (rrule || vevent.getFirstProperty("rdate")) {
    // §3.5: expand in the event's ORIGINAL TZID, then convert each instance to
    // UTC. That ordering is the whole point — a weekly 10:00 Madrid class must
    // produce 08:00Z instances in winter and 09:00Z in summer. Expanding in UTC
    // (what `rrule` does) pins the instant and drifts the local time instead.
    //
    // Because we read wall-clock components rather than instants, ical.js's
    // expansion runs entirely in local wall time and each instance is converted
    // independently below — which is exactly the required semantics.
    const expansion = new ICAL.RecurExpansion({ component: vevent, dtstart });
    const horizonFrom = options.horizon
      ? Date.parse(options.horizon.fromUtc)
      : Number.NEGATIVE_INFINITY;
    const horizonTo = options.horizon
      ? Date.parse(options.horizon.toUtc)
      : Number.POSITIVE_INFINITY;

    let produced = 0;
    while (produced < maxOccurrences) {
      const next = expansion.next();
      if (!next) {
        break;
      }

      const recurrenceId = next.toString();
      const override = extras.overrides.get(recurrenceId);

      const instanceStartProperty = override?.getFirstProperty("dtstart");
      const instanceStart = instanceStartProperty
        ? (readTime(instanceStartProperty) ?? next)
        : next;
      const instanceStartTzid = instanceStartProperty ? tzidOf(instanceStartProperty) : startTzid;

      const instanceEndProperty = override?.getFirstProperty("dtend");
      const instanceEnd = instanceEndProperty ? readTime(instanceEndProperty) : effectiveEnd(next);
      const instanceEndTzid = instanceEndProperty
        ? tzidOf(instanceEndProperty)
        : (endTzid ?? startTzid);

      const built = buildOccurrence(
        recurrenceId,
        instanceStart,
        instanceEnd,
        instanceStartTzid,
        instanceEndTzid,
        allDay,
        override ? statusOf(override) : status,
        override !== undefined,
        context,
      );
      if (!built.ok) {
        return built;
      }

      const startMs = Date.parse(built.value.startsAtUtc);
      if (startMs > horizonTo) {
        break;
      }
      if (startMs >= horizonFrom) {
        occurrences.push(built.value);
      }
      produced += 1;
    }
  } else {
    const built = buildOccurrence(
      "",
      dtstart,
      effectiveEnd(dtstart),
      startTzid,
      endTzid ?? startTzid,
      allDay,
      status,
      false,
      context,
    );
    if (!built.ok) {
      return built;
    }
    occurrences.push(built.value);
  }

  const location = readString(vevent, "location");
  const descriptionRaw = readString(vevent, "description");

  const event: NormalizedEvent = {
    uid,
    sequence,
    kind: classifyKind({
      normalized,
      occurrences,
      hasRrule: rrule !== undefined,
      categories: vevent.getAllProperties("categories").flatMap((property) => {
        const value = property.getFirstValue();
        return typeof value === "string" ? [value] : [];
      }),
      knownCourseNames: options.knownCourseNames ?? [],
    }),
    title: normalized.title,
    rawSummary: normalized.rawSummary,
    occurrences,
    descriptor: normalized.descriptor,
  };

  // ⚠ `DESCRIPTION` is PRESENT on 379/379 events and blank-after-trim on 378 —
  // the literal two-character value `\n\n`. `if (description)` is therefore
  // truthy on every single event in the feed. Testing the trimmed value is the
  // documented fix for a real past bug; do not simplify this back.
  if (descriptionRaw !== undefined && descriptionRaw.trim().length > 0) {
    event.description = descriptionRaw;
  }
  if (location !== undefined && location.trim().length > 0) {
    // §5.1b: the room comes from LOCATION, never from SUMMARY, where it is a
    // duplicate — and where `Asynchronous` is a modality, not a room.
    event.location = location;
  }
  if (rrule !== undefined) {
    event.rrule = rrule;
  }
  if (startTzid !== null) {
    event.originalTzid = startTzid;
  }
  if (normalized.sessionFrom !== undefined) {
    event.sessionFrom = normalized.sessionFrom;
  }
  if (normalized.sessionTo !== undefined) {
    event.sessionTo = normalized.sessionTo;
  }
  if (normalized.courseName.length > 0) {
    event.courseHint = normalized.courseName;
  }

  return ok(event);
}
