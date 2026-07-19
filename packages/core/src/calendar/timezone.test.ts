import { describe, expect, it } from "vitest";
import {
  isKnownTimezone,
  timezoneOffsetMs,
  UnknownTimezoneError,
  wallClockToUtcIso,
} from "./timezone";

const HOUR = 3_600_000;

function madrid(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  return { year, month, day, hour, minute, second: 0 };
}

describe("isKnownTimezone", () => {
  it("accepts IANA ids and rejects everything else", () => {
    expect(isKnownTimezone("Europe/Madrid")).toBe(true);
    expect(isKnownTimezone("UTC")).toBe(true);
    expect(isKnownTimezone("America/New_York")).toBe(true);
    expect(isKnownTimezone("Not/AZone")).toBe(false);
    expect(isKnownTimezone("Customized Time Zone")).toBe(false);
  });
});

describe("Europe/Madrid DST — the 2026 transitions", () => {
  /**
   * ⚠ CORRECTED 2026-07-18: the transitions are **29 March** and **25 October**
   * 2026, not the "27 Mar / 26 Oct" that PLAN.md §3.4 names. Those two dates are
   * the nearest *event-bearing weekdays* around the transitions (the feed has no
   * weekend classes), and 26 Oct is already on the winter side. EU DST changes on
   * the last Sunday of March and October; in 2026 those are the 29th and the 25th.
   * Asserting on the real Sundays is what actually proves the offset logic.
   */
  it("switches CET→CEST at 01:00 UTC on Sunday 29 March 2026", () => {
    const before = Date.parse("2026-03-29T00:59:00Z");
    const after = Date.parse("2026-03-29T01:00:00Z");
    expect(timezoneOffsetMs(before, "Europe/Madrid")).toBe(1 * HOUR);
    expect(timezoneOffsetMs(after, "Europe/Madrid")).toBe(2 * HOUR);
  });

  it("switches CEST→CET at 01:00 UTC on Sunday 25 October 2026", () => {
    const before = Date.parse("2026-10-25T00:59:00Z");
    const after = Date.parse("2026-10-25T01:00:00Z");
    expect(timezoneOffsetMs(before, "Europe/Madrid")).toBe(2 * HOUR);
    expect(timezoneOffsetMs(after, "Europe/Madrid")).toBe(1 * HOUR);
  });

  it("keeps a 10:00 class at 10:00 local while its UTC shifts across March", () => {
    // Winter (CET, UTC+1) → 09:00Z. Summer (CEST, UTC+2) → 08:00Z.
    expect(wallClockToUtcIso(madrid(2026, 3, 27, 10, 0), "Europe/Madrid")).toBe(
      "2026-03-27T09:00:00.000Z",
    );
    expect(wallClockToUtcIso(madrid(2026, 3, 30, 10, 0), "Europe/Madrid")).toBe(
      "2026-03-30T08:00:00.000Z",
    );
  });

  it("keeps a 10:00 class at 10:00 local while its UTC shifts across October", () => {
    expect(wallClockToUtcIso(madrid(2026, 10, 23, 10, 0), "Europe/Madrid")).toBe(
      "2026-10-23T08:00:00.000Z",
    );
    expect(wallClockToUtcIso(madrid(2026, 10, 26, 10, 0), "Europe/Madrid")).toBe(
      "2026-10-26T09:00:00.000Z",
    );
  });

  it("resolves the autumn overlap to the earlier (still-DST) instant", () => {
    // 02:30 on 25 Oct 2026 happens twice: 00:30Z (CEST) and 01:30Z (CET).
    expect(wallClockToUtcIso(madrid(2026, 10, 25, 2, 30), "Europe/Madrid")).toBe(
      "2026-10-25T00:30:00.000Z",
    );
  });

  it("resolves the spring gap forward rather than throwing", () => {
    // 02:30 on 29 Mar 2026 never exists — the clock jumps 02:00→03:00.
    // The post-transition reading (03:30 local, 01:30Z) is the sane answer.
    expect(wallClockToUtcIso(madrid(2026, 3, 29, 2, 30), "Europe/Madrid")).toBe(
      "2026-03-29T01:30:00.000Z",
    );
  });
});

describe("failing loudly", () => {
  it("throws UnknownTimezoneError for a non-IANA id rather than floating", () => {
    expect(() => wallClockToUtcIso(madrid(2026, 5, 1, 10, 0), "Not/AZone")).toThrow(
      UnknownTimezoneError,
    );
  });
});

describe("other zones", () => {
  it("round-trips a non-European zone", () => {
    // 2026-01-15 09:00 New York (EST, UTC-5) → 14:00Z.
    expect(wallClockToUtcIso(madrid(2026, 1, 15, 9, 0), "America/New_York")).toBe(
      "2026-01-15T14:00:00.000Z",
    );
  });

  it("treats UTC as a zero offset", () => {
    expect(wallClockToUtcIso(madrid(2026, 6, 1, 12, 0), "UTC")).toBe("2026-06-01T12:00:00.000Z");
  });
});
