import { describe, expect, it } from "vitest";
import { HORIZON_DAYS, weekWindow } from "./week";

const MADRID = "Europe/Madrid";

describe("weekWindow", () => {
  it("starts on Monday local midnight and ends on the next Monday", () => {
    // Wednesday 2026-09-16, 14:00 Madrid (CEST, +02:00).
    const window = weekWindow("2026-09-16T12:00:00.000Z", MADRID);

    expect(window.startUtc).toBe("2026-09-13T22:00:00.000Z"); // Mon 14th, 00:00 +02
    expect(window.endUtc).toBe("2026-09-20T22:00:00.000Z"); // Mon 21st, 00:00 +02
    expect(window.dayStartsUtc).toHaveLength(7);
  });

  it("treats Monday itself as the first day of its own week, not the last of the previous", () => {
    const window = weekWindow("2026-09-14T05:00:00.000Z", MADRID);
    expect(window.startUtc).toBe("2026-09-13T22:00:00.000Z");
  });

  it("treats Sunday as the last day of the week that began six days earlier", () => {
    // Sunday 2026-09-20, 23:30 Madrid — still inside the week, only just.
    const window = weekWindow("2026-09-20T21:30:00.000Z", MADRID);
    expect(window.startUtc).toBe("2026-09-13T22:00:00.000Z");
    expect(window.endUtc).toBe("2026-09-20T22:00:00.000Z");
    expect(Date.parse("2026-09-20T21:30:00.000Z")).toBeLessThan(Date.parse(window.endUtc));
  });

  it("puts the horizon 14 days past the end of the week", () => {
    const window = weekWindow("2026-09-16T12:00:00.000Z", MADRID);
    const days = (Date.parse(window.horizonEndUtc) - Date.parse(window.endUtc)) / 86_400_000;
    expect(days).toBe(HORIZON_DAYS);
  });

  /**
   * The reason this module exists rather than a few lines of arithmetic in the
   * RSC. On an autumn-back week the local day is 25 hours long, so every
   * boundary computed by adding 24 h to the previous one lands an hour early
   * from Sunday onward — moving a Sunday-evening deadline into the wrong week.
   */
  it("holds local midnight across the autumn-back transition", () => {
    // Week of Mon 2026-10-19; Madrid falls back 03:00 → 02:00 on Sun 2026-10-25.
    const window = weekWindow("2026-10-21T10:00:00.000Z", MADRID);

    expect(window.startUtc).toBe("2026-10-18T22:00:00.000Z"); // Mon 19th 00:00 +02
    // Sunday the 25th begins at 00:00 +02 — still CEST, the change is at 03:00.
    expect(window.dayStartsUtc[6]).toBe("2026-10-24T22:00:00.000Z");
    // …but Monday the 26th begins at 00:00 +01, i.e. 25 hours later, not 24.
    expect(window.endUtc).toBe("2026-10-25T23:00:00.000Z");

    const finalDayMs = Date.parse(window.endUtc) - Date.parse("2026-10-24T22:00:00.000Z");
    expect(finalDayMs).toBe(25 * 3_600_000);
  });

  it("holds local midnight across the spring-forward transition", () => {
    // Madrid springs forward 02:00 → 03:00 on Sun 2026-03-29.
    const window = weekWindow("2026-03-25T10:00:00.000Z", MADRID);

    expect(window.startUtc).toBe("2026-03-22T23:00:00.000Z"); // Mon 23rd 00:00 +01
    expect(window.endUtc).toBe("2026-03-29T22:00:00.000Z"); // Mon 30th 00:00 +02

    const finalDayMs = Date.parse(window.endUtc) - Date.parse(window.dayStartsUtc[6] ?? "");
    expect(finalDayMs).toBe(23 * 3_600_000);
  });

  it("every day boundary is local midnight, never an accumulated offset", () => {
    const window = weekWindow("2026-10-21T10:00:00.000Z", MADRID);
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: MADRID,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });

    for (const dayStart of window.dayStartsUtc) {
      expect(formatter.format(new Date(dayStart))).toBe("00:00");
    }
  });

  it("is timezone-relative: the same instant belongs to different weeks elsewhere", () => {
    // Sunday 2026-09-20 23:30 UTC is already Monday 01:30 in Madrid, so Madrid
    // has moved on to the next week while UTC has not.
    const madrid = weekWindow("2026-09-20T23:30:00.000Z", MADRID);
    const utc = weekWindow("2026-09-20T23:30:00.000Z", "UTC");

    expect(madrid.startUtc).toBe("2026-09-20T22:00:00.000Z");
    expect(utc.startUtc).toBe("2026-09-14T00:00:00.000Z");
  });

  it("accepts a Date and an epoch millisecond count as well as an ISO string", () => {
    const iso = weekWindow("2026-09-16T12:00:00.000Z", MADRID);
    expect(weekWindow(new Date("2026-09-16T12:00:00.000Z"), MADRID)).toEqual(iso);
    expect(weekWindow(Date.parse("2026-09-16T12:00:00.000Z"), MADRID)).toEqual(iso);
  });

  /**
   * ⚠ The live state on the day this was written. The fall term starts
   * 2026-08-31, so the real week window today contains nothing at all — which
   * is a correct answer, not a broken one, and the view has to say so.
   */
  it("resolves a real, empty summer week (2026-07-18, term not started)", () => {
    const window = weekWindow("2026-07-18T09:00:00.000Z", MADRID);
    expect(window.startUtc).toBe("2026-07-12T22:00:00.000Z"); // Mon 13 July
    expect(window.endUtc).toBe("2026-07-19T22:00:00.000Z"); // Mon 20 July
  });
});
