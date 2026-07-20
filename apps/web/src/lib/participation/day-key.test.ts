import { describe, expect, it } from "vitest";
import { sessionDayKey } from "./day-key";

/**
 * "Today" on the ledger is the user's wall-clock day (`profiles.timezone`),
 * never the UTC day. The boundary case was proven red against a UTC-slicing
 * scaffold first: Madrid runs ahead of UTC, so a late-evening UTC instant is
 * already tomorrow there, and slicing the ISO string files tonight's class
 * under yesterday's list — exactly the kind of off-by-one that quietly makes
 * a session unloggable on the day it happens.
 */

describe("sessionDayKey", () => {
  it("files a 00:30 Madrid class under the Madrid day, not the UTC one", () => {
    // 2026-09-14T22:30Z is 00:30 on 15 September in Europe/Madrid (CEST).
    expect(sessionDayKey("2026-09-14T22:30:00Z", "Europe/Madrid")).toBe("2026-09-15");
  });

  it("west of Greenwich the boundary moves the other way", () => {
    // 2026-09-15T03:30Z is still 23:30 on 14 September in New York (EDT).
    expect(sessionDayKey("2026-09-15T03:30:00Z", "America/New_York")).toBe("2026-09-14");
  });

  it("an instant well inside a day agrees with everyone", () => {
    expect(sessionDayKey("2026-09-15T10:00:00Z", "Europe/Madrid")).toBe("2026-09-15");
  });
});
