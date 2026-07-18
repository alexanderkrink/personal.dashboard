import { describe, expect, it } from "vitest";
import SAMPLE from "./__fixtures__/ie-agenda-sample.ics?raw";
import SYNTHETIC from "./__fixtures__/recurring-synthetic.ics?raw";
import type { NormalizedEvent, ParseIcsResult } from "./index";
import { parseIcsToNormalizedEvents } from "./parse-ics";
import { isKnownTimezone as isKnownTimezoneId } from "./timezone";

/**
 * Fixtures load through Vite's `?raw` transform rather than `node:fs`.
 *
 * `packages/core` deliberately has **no `@types/node`**, which is what makes the
 * "no Node built-ins" boundary rule an enforced invariant instead of a
 * convention: a `node:fs` import in library code fails typecheck. The earlier
 * `readFileSync` + `fileURLToPath` test helper would have forced `@types/node`
 * into the package and quietly disarmed that guard for *all* of `src` — so the
 * fixture is inlined at transform time instead. Nothing Node-specific is
 * reachable from either the tests or the library.
 */

function parseOrThrow(ics: string, defaultTimezone = "Europe/Madrid"): ParseIcsResult {
  const result = parseIcsToNormalizedEvents(ics, { defaultTimezone });
  if (!result.ok) {
    throw new Error(`Parse failed: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

function byUid(events: readonly NormalizedEvent[], uid: string): NormalizedEvent {
  const event = events.find((candidate) => candidate.uid === uid);
  if (!event) {
    throw new Error(`No event with uid ${uid}`);
  }
  return event;
}

describe("parseIcsToNormalizedEvents — the sanitized IE sample", () => {
  const { events, droppedPseudoRows } = parseOrThrow(SAMPLE);

  it("filters exactly the 5 pseudo/LMS rows", () => {
    expect(droppedPseudoRows).toHaveLength(5);
  });

  it("keeps both real APPLIED BUSINESS MATHEMATICS rows", () => {
    const abm = events.filter((event) => event.courseHint === "APPLIED BUSINESS MATHEMATICS");
    expect(abm.map((event) => event.uid).sort()).toEqual([
      "FIXTURE-ABM-REAL-EXTRA",
      "FIXTURE-ABM-REAL-RETAKE",
    ]);
  });

  it("drops both ABM pseudo rows while keeping the prefix's real events", () => {
    expect(
      droppedPseudoRows.filter((raw) => raw.includes("APPLIED BUSINESS MATHEMATICS")),
    ).toHaveLength(2);
  });

  it("collapses the three MARKETING MANAGEMENT variants into one course", () => {
    const marketing = events.filter((event) => event.courseHint === "MARKETING MANAGEMENT");
    expect(marketing).toHaveLength(4);
    expect(new Set(marketing.map((event) => event.rawSummary)).size).toBe(4);
    expect(new Set(marketing.map((event) => event.courseHint)).size).toBe(1);
  });

  it("preserves the verbatim rawSummary so the normalizer can be re-run", () => {
    expect(byUid(events, "FIXTURE-MM-NULL-1").rawSummary).toBe(
      "MARKETING MANAGEMENT   | | , null (Ses. 3) T-04.02",
    );
  });
});

describe("DESCRIPTION is present-but-blank on every event", () => {
  const { events } = parseOrThrow(SAMPLE);

  it("does not set description for the literal \\n\\n value", () => {
    // ⚠ The documented past bug: `if (description)` is TRUTHY on all 379 real
    // events because the value is the two-character string `\n\n`. Only
    // `.trim()` distinguishes them. Do not reintroduce.
    for (const event of events) {
      expect(event.description).toBeUndefined();
    }
  });

  it("proves the raw value would have been truthy", () => {
    const raw = "\\n\\n";
    expect(Boolean(raw)).toBe(true);
    expect(raw.trim().length > 0).toBe(true);
    // ...and the parsed (unescaped) form is what actually reaches us:
    expect("\n\n".trim().length).toBe(0);
  });
});

describe("timezone resolution — 738 naked TZIDs, zero VTIMEZONE", () => {
  const { events } = parseOrThrow(SAMPLE);

  it("records the original TZID", () => {
    expect(byUid(events, "FIXTURE-0001").originalTzid).toBe("Europe/Madrid");
  });

  it("resolves a winter class through the IANA fallback", () => {
    // 2026-01-19 11:00 Madrid (CET, +01) → 10:00Z
    expect(byUid(events, "FIXTURE-0001").occurrences[0]?.startsAtUtc).toBe(
      "2026-01-19T10:00:00.000Z",
    );
  });

  it("anchors an all-day event to midnight in the profile timezone", () => {
    // 🔴 The IE feed writes all-day rows as a DATE-only DTSTART with a TZID and
    // DURATION:P1D — and NO `VALUE=DATE` parameter. 20 events in the real export
    // use this shape, and ical.js decodes it to the malformed jCal value
    // `"2026-01-20T::"` and THROWS on it. `readTime()` repairs that before
    // decoding; without the repair this row fails the entire feed.
    const allDay = byUid(events, "FIXTURE-0002");
    expect(allDay.occurrences[0]?.allDay).toBe(true);
    // Midnight on 2026-01-20 Madrid (CET) → 23:00Z the previous day.
    expect(allDay.occurrences[0]?.startsAtUtc).toBe("2026-01-19T23:00:00.000Z");
  });

  it("anchors all-day rows in the PROFILE zone, ignoring the property's TZID", () => {
    // §3.4 rule 5: "anchored to midnight in the profile timezone… so they can't
    // drift across midnight for users who travel". RFC 5545 agrees — a DATE
    // value must not carry a TZID at all, so the `TZID=Europe/Madrid` the IE
    // feed attaches to these rows is meaningless and must not re-anchor the day.
    const inNewYork = parseOrThrow(SAMPLE, "America/New_York");
    const allDay = byUid(inNewYork.events, "FIXTURE-0002");
    expect(allDay.occurrences[0]?.allDay).toBe(true);
    // Midnight 2026-01-20 New York (EST, −05) → 05:00Z, not Madrid's 23:00Z.
    expect(allDay.occurrences[0]?.startsAtUtc).toBe("2026-01-20T05:00:00.000Z");

    // A timed row in the same document still honours its TZID — only all-day
    // rows ignore it.
    expect(byUid(inNewYork.events, "FIXTURE-0001").occurrences[0]?.startsAtUtc).toBe(
      "2026-01-19T10:00:00.000Z",
    );
  });

  it("passes a UTC (...Z) value straight through", () => {
    const utcOnly = parseOrThrow(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//t//EN",
        "BEGIN:VEVENT",
        "UID:UTC-1",
        "DTSTAMP:20260101T000000Z",
        "DTSTART:20260615T140000Z",
        "DTEND:20260615T150000Z",
        "SUMMARY:UTC COURSE    (Ses. 1) T-1",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    expect(utcOnly.events[0]?.occurrences[0]?.startsAtUtc).toBe("2026-06-15T14:00:00.000Z");
  });

  it("interprets a floating time in the caller-supplied defaultTimezone", () => {
    const floating = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//t//EN",
      "BEGIN:VEVENT",
      "UID:FLOAT-1",
      "DTSTAMP:20260101T000000Z",
      "DTSTART:20260615T140000",
      "DTEND:20260615T150000",
      "SUMMARY:FLOATING COURSE    (Ses. 1) T-1",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    // Madrid in June is CEST (+02) → 12:00Z.
    expect(parseOrThrow(floating, "Europe/Madrid").events[0]?.occurrences[0]?.startsAtUtc).toBe(
      "2026-06-15T12:00:00.000Z",
    );
    // The same floating value in New York (EDT, −04) → 18:00Z.
    expect(parseOrThrow(floating, "America/New_York").events[0]?.occurrences[0]?.startsAtUtc).toBe(
      "2026-06-15T18:00:00.000Z",
    );
  });

  /**
   * §3.4 rule 2's *other* half: a feed that does ship `VTIMEZONE` blocks must
   * have them registered with `ICAL.TimezoneService` before expansion, because
   * ical.js carries no tz data and registers nothing automatically.
   *
   * The IE feed has zero of these — which is exactly why the IANA path is the
   * primary one — so this capability has no real-data fixture and is proven
   * synthetically instead.
   */
  describe("VTIMEZONE registration — for feeds that ship one", () => {
    /** A proprietary, non-IANA zone id carrying its own definition (UTC+03). */
    const withVtimezone = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//t//EN",
      "BEGIN:VTIMEZONE",
      "TZID:Customized Time Zone",
      "BEGIN:STANDARD",
      "DTSTART:16010101T000000",
      "TZOFFSETFROM:+0300",
      "TZOFFSETTO:+0300",
      "END:STANDARD",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "UID:VTZ-1",
      "DTSTAMP:20260101T000000Z",
      "DTSTART;TZID=Customized Time Zone:20260615T140000",
      "DTEND;TZID=Customized Time Zone:20260615T150000",
      "SUMMARY:CUSTOM ZONE COURSE    (Ses. 1) T-1",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    /** The same event, but the definition has been stripped out. */
    const withoutVtimezone = withVtimezone.replace(/BEGIN:VTIMEZONE[\s\S]*?END:VTIMEZONE\r\n/, "");

    it("resolves a non-IANA TZID through the feed's own VTIMEZONE", () => {
      // `Customized Time Zone` is not an IANA id, so `Intl` cannot help — only
      // the registered definition can. 14:00 at +03:00 → 11:00Z.
      expect(isKnownTimezoneId("Customized Time Zone")).toBe(false);
      const parsed = parseOrThrow(withVtimezone);
      expect(parsed.events[0]?.occurrences[0]?.startsAtUtc).toBe("2026-06-15T11:00:00.000Z");
    });

    it("scopes the registry to ONE parse — no leak into the next feed", () => {
      // `ICAL.TimezoneService` is a process-global singleton. If the parser did
      // not deregister, one feed's proprietary zone would silently resolve
      // another feed's identically-named TZID. Parsing the stripped document
      // immediately after the full one must therefore FAIL.
      parseOrThrow(withVtimezone);

      const leaked = parseIcsToNormalizedEvents(withoutVtimezone, {
        defaultTimezone: "Europe/Madrid",
      });
      expect(leaked.ok).toBe(false);
      if (!leaked.ok && leaked.error.kind === "parse") {
        expect(leaked.error.detail).toContain("Customized Time Zone");
      }
    });
  });

  it("fails LOUDLY on a TZID that is not IANA-resolvable", () => {
    const result = parseIcsToNormalizedEvents(SYNTHETIC, { defaultTimezone: "Europe/Madrid" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("parse");
      expect(result.error).toMatchObject({ kind: "parse" });
      if (result.error.kind === "parse") {
        expect(result.error.detail).toContain("Not/AZone");
        expect(result.error.detail).toContain("Unresolvable TZID");
      }
    }
  });
});

/**
 * DST — the bug class that disqualified the `rrule` package (§3.7).
 *
 * ⚠ **CORRECTED 2026-07-18: the 2026 transitions are 29 March and 25 October**,
 * the last Sundays of each month — not the "27 Mar / 26 Oct" those dates are
 * sometimes quoted as. 27 Mar is a Friday still on winter time and 26 Oct is a
 * Monday already on winter time; neither is a transition. The fixtures below are
 * real-derived events that straddle the *true* Sundays.
 *
 * The assertion that matters is the **local** one: the class does not move. The
 * UTC assertion alone would pass for a parser that shifted the local time and
 * pinned the instant — exactly what a UTC-based expander does.
 */
describe("DST — a class stays at its local time while UTC shifts", () => {
  const { events } = parseOrThrow(SAMPLE);

  const MADRID = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

  /** Renders a stored UTC instant back into Madrid wall-clock time. */
  function inMadrid(uid: string): string {
    const startsAtUtc = byUid(events, uid).occurrences[0]?.startsAtUtc;
    if (!startsAtUtc) {
      throw new Error(`No occurrence for ${uid}`);
    }
    return MADRID.format(new Date(startsAtUtc));
  }

  it("March — 10:30 local on BOTH sides of the 29 Mar transition", () => {
    // Winter (CET, +01): 10:30 local is 09:30Z. Summer (CEST, +02): 08:30Z.
    expect(byUid(events, "FIXTURE-DST-MAR-BEFORE").occurrences[0]?.startsAtUtc).toBe(
      "2026-03-27T09:30:00.000Z",
    );
    expect(byUid(events, "FIXTURE-DST-MAR-AFTER").occurrences[0]?.startsAtUtc).toBe(
      "2026-04-07T08:30:00.000Z",
    );

    // The UTC offsets differ by an hour...
    expect(inMadrid("FIXTURE-DST-MAR-BEFORE")).toContain("CET");
    expect(inMadrid("FIXTURE-DST-MAR-AFTER")).toContain("CEST");
    // ...and yet the student shows up at 10:30 on both days.
    expect(inMadrid("FIXTURE-DST-MAR-BEFORE")).toBe("27/03/2026, 10:30 CET");
    expect(inMadrid("FIXTURE-DST-MAR-AFTER")).toBe("07/04/2026, 10:30 CEST");
  });

  it("October — 08:30 local on BOTH sides of the 25 Oct transition", () => {
    // Summer (CEST, +02): 08:30 local is 06:30Z. Winter (CET, +01): 07:30Z.
    expect(byUid(events, "FIXTURE-DST-OCT-BEFORE").occurrences[0]?.startsAtUtc).toBe(
      "2026-10-23T06:30:00.000Z",
    );
    expect(byUid(events, "FIXTURE-DST-OCT-AFTER").occurrences[0]?.startsAtUtc).toBe(
      "2026-10-26T07:30:00.000Z",
    );

    expect(inMadrid("FIXTURE-DST-OCT-BEFORE")).toContain("CEST");
    expect(inMadrid("FIXTURE-DST-OCT-AFTER")).toContain("CET");
    expect(inMadrid("FIXTURE-DST-OCT-BEFORE")).toBe("23/10/2026, 08:30 CEST");
    expect(inMadrid("FIXTURE-DST-OCT-AFTER")).toBe("26/10/2026, 08:30 CET");
  });

  it("the stored UTC instants really do differ by an hour for the same local time", () => {
    // Guards against the inverse bug: a parser that keeps UTC constant and lets
    // the local time drift would make these two equal.
    const marchBefore = byUid(events, "FIXTURE-DST-MAR-BEFORE").occurrences[0]?.startsAtUtc ?? "";
    const marchAfter = byUid(events, "FIXTURE-DST-MAR-AFTER").occurrences[0]?.startsAtUtc ?? "";
    expect(marchBefore.slice(11, 16)).toBe("09:30");
    expect(marchAfter.slice(11, 16)).toBe("08:30");

    const octoberBefore = byUid(events, "FIXTURE-DST-OCT-BEFORE").occurrences[0]?.startsAtUtc ?? "";
    const octoberAfter = byUid(events, "FIXTURE-DST-OCT-AFTER").occurrences[0]?.startsAtUtc ?? "";
    expect(octoberBefore.slice(11, 16)).toBe("06:30");
    expect(octoberAfter.slice(11, 16)).toBe("07:30");
  });
});

describe("LOCATION is the room, SUMMARY is not", () => {
  const { events } = parseOrThrow(SAMPLE);

  it("takes the room from LOCATION", () => {
    expect(byUid(events, "FIXTURE-0001").location).toBe("T-01.01");
  });

  it("keeps Asynchronous as a LOCATION value — a modality, not a room", () => {
    expect(byUid(events, "FIXTURE-0002").location).toBe("Asynchronous");
  });
});

describe("session grammar reaches the normalized event", () => {
  const { events } = parseOrThrow(SAMPLE);

  it("carries a single session", () => {
    const event = byUid(events, "FIXTURE-0001");
    expect(event.sessionFrom).toBe(4);
    expect(event.sessionTo).toBe(4);
  });

  it("carries a ranged session", () => {
    const event = byUid(events, "FIXTURE-BPR-RANGE");
    expect(event.sessionFrom).toBe(24);
    expect(event.sessionTo).toBe(25);
  });

  it("classifies session-bearing rows as class (kind rule 1)", () => {
    expect(byUid(events, "FIXTURE-0001").kind).toBe("class");
    expect(byUid(events, "FIXTURE-ABM-REAL-EXTRA").kind).toBe("class");
    expect(byUid(events, "FIXTURE-ABM-REAL-RETAKE").kind).toBe("class");
  });

  it("classifies a tokenless known-course row as class (kind rule 1b)", () => {
    const withoutCourses = parseOrThrow(SAMPLE);
    expect(byUid(withoutCourses.events, "FIXTURE-0005").kind).toBe("event");

    const withCourses = parseIcsToNormalizedEvents(SAMPLE, {
      defaultTimezone: "Europe/Madrid",
      knownCourseNames: ["COST ACCOUNTING"],
    });
    expect(withCourses.ok).toBe(true);
    if (withCourses.ok) {
      expect(byUid(withCourses.value.events, "FIXTURE-0005").kind).toBe("class");
    }
  });
});

describe("recurrence — generic capability (the IE feed has none)", () => {
  /** The bad-TZID event is stripped so the rest of the fixture can be parsed. */
  const RECURRING_ONLY = SYNTHETIC.replace(
    /BEGIN:VEVENT\r?\n(?:(?!END:VEVENT)[\s\S])*Not\/AZone[\s\S]*?END:VEVENT\r?\n/,
    "",
  );

  const { events } = parseOrThrow(RECURRING_ONLY);

  it("expands an RRULE and honours EXDATE", () => {
    const weekly = byUid(events, "SYNTH-WEEKLY-DST-MARCH");
    // COUNT=6 weekly from 16 Mar, minus the 23 Mar EXDATE → 5 instances.
    expect(weekly.occurrences).toHaveLength(5);
    expect(weekly.occurrences.map((occurrence) => occurrence.startsAtUtc)).not.toContain(
      "2026-03-23T09:00:00.000Z",
    );
  });

  it("expands in the ORIGINAL TZID then converts — 10:00 Madrid stays 10:00 across March", () => {
    const weekly = byUid(events, "SYNTH-WEEKLY-DST-MARCH");
    const starts = weekly.occurrences.map((occurrence) => occurrence.startsAtUtc);
    // 16 Mar and 30 Mar are both Mondays at 10:00 local, but straddle 29 Mar.
    expect(starts).toContain("2026-03-16T09:00:00.000Z"); // CET  → 09:00Z
    expect(starts).toContain("2026-03-30T08:00:00.000Z"); // CEST → 08:00Z
  });

  it("expands correctly across the October transition too", () => {
    const autumn = byUid(events, "SYNTH-WEEKLY-DST-OCTOBER");
    const starts = autumn.occurrences.map((occurrence) => occurrence.startsAtUtc);
    expect(starts).toContain("2026-10-19T08:00:00.000Z"); // CEST → 08:00Z
    expect(starts).toContain("2026-11-02T09:00:00.000Z"); // CET  → 09:00Z
  });

  it("applies a RECURRENCE-ID override and flags it", () => {
    const weekly = byUid(events, "SYNTH-WEEKLY-DST-MARCH");
    const override = weekly.occurrences.find((occurrence) => occurrence.overridden);
    expect(override).toBeDefined();
    expect(override?.status).toBe("cancelled");
  });

  it("respects the horizon window", () => {
    const windowed = parseIcsToNormalizedEvents(RECURRING_ONLY, {
      defaultTimezone: "Europe/Madrid",
      horizon: { fromUtc: "2026-03-20T00:00:00Z", toUtc: "2026-04-10T00:00:00Z" },
    });
    expect(windowed.ok).toBe(true);
    if (windowed.ok) {
      const weekly = byUid(windowed.value.events, "SYNTH-WEEKLY-DST-MARCH");
      for (const occurrence of weekly.occurrences) {
        expect(Date.parse(occurrence.startsAtUtc)).toBeGreaterThanOrEqual(
          Date.parse("2026-03-20T00:00:00Z"),
        );
      }
    }
  });
});

describe("malformed input", () => {
  it("returns a parse error rather than throwing", () => {
    const result = parseIcsToNormalizedEvents("this is not an ics document", {
      defaultTimezone: "Europe/Madrid",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("parse");
    }
  });
});
