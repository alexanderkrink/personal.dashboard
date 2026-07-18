/**
 * Tier 2 — assertions against the **real, gitignored** IE export.
 *
 * The committed `__fixtures__/ie-agenda-sample.ics` is a sanitized 24-event
 * distillation that preserves every structural property the parser has to
 * survive. It cannot, by construction, prove the aggregate facts: that the feed
 * really does hold 379 events, that exactly 5 are pseudo rows, or that the fall
 * term really does collapse from 9 apparent name variants to 7 courses. Those
 * only hold against the whole document, so they are asserted here — against
 * `apps/web/.local-fixtures/calendar/ie-agenda-20260718.ics`, which is
 * gitignored and never committed.
 *
 * ## The skip path, and why it is a glob
 *
 * CI has no fixture, so this file **must** skip cleanly rather than fail.
 * `import.meta.glob` is what makes that structural: a pattern matching no files
 * yields `{}`, so `REAL_FEED` is `undefined` and every `skipIf` below fires. A
 * `readFileSync` on a missing path throws at import time and takes the whole
 * suite down with it, and no `existsSync` guard can be written without pulling
 * `node:fs` — and therefore `@types/node` — into a package that deliberately has
 * neither (see `src/vite-env.d.ts`).
 *
 * Never commit the export. Never print the feed URL — it embeds a capability
 * token (§2, `calendar_feeds.config`).
 */

import { describe, expect, it } from "vitest";
import { detectExam, type ExamCandidateEvent } from "./exam-detection";
import { parseIcsToNormalizedEvents } from "./parse-ics";
import type { NormalizedEvent } from "./provider";
import { expandSessionRange, normalizeSummary } from "./summary";

const LOCAL_FEEDS = import.meta.glob("../../../../apps/web/.local-fixtures/calendar/*.ics", {
  query: "?raw",
  import: "default",
  eager: true,
});

const REAL_FEED: string | undefined = Object.values(LOCAL_FEEDS)[0];
const hasFeed = typeof REAL_FEED === "string" && REAL_FEED.length > 0;

/** The fall-2026 term. Everything before 2026-06-26 is 2025/26 spring + June re-sits. */
const FALL_FROM = "2026-09-01";
const FALL_TO = "2026-12-31";

function parseRealFeed(): { events: NormalizedEvent[]; droppedPseudoRows: string[] } {
  const result = parseIcsToNormalizedEvents(REAL_FEED as string, {
    defaultTimezone: "Europe/Madrid",
  });
  if (!result.ok) {
    throw new Error(`Real feed failed to parse: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

/** Groups fall events by normalised course name, tracking range-expanded max session. */
function groupFallByCourse(
  events: readonly NormalizedEvent[],
): Map<string, { events: number; maxSession: number }> {
  const grouped = new Map<string, { events: number; maxSession: number }>();
  for (const event of events) {
    const startsAt = event.occurrences[0]?.startsAtUtc ?? "";
    if (startsAt < FALL_FROM || startsAt > FALL_TO) {
      continue;
    }
    const key = event.courseHint ?? "(unmatched)";
    const entry = grouped.get(key) ?? { events: 0, maxSession: 0 };
    entry.events += 1;
    const normalized = normalizeSummary(event.rawSummary);
    for (const session of normalized ? expandSessionRange(normalized) : []) {
      entry.maxSession = Math.max(entry.maxSession, session);
    }
    grouped.set(key, entry);
  }
  return grouped;
}

describe.skipIf(!hasFeed)("the real IE export — Tier 2 (local only)", () => {
  it("parses end to end without a SyncError", () => {
    // Not a formality. Before the all-day repair in `readTime()`, the 20
    // `DTSTART;TZID=Europe/Madrid:20260120` + `DURATION:P1D` rows made ical.js
    // throw `invalid date-time value: "2026-01-20T::"` and this returned a
    // parse error for the entire feed.
    const result = parseIcsToNormalizedEvents(REAL_FEED as string, {
      defaultTimezone: "Europe/Madrid",
    });
    expect(result.ok).toBe(true);
  });

  it("filters exactly 5 pseudo rows, leaving 374 of 379", () => {
    const { events, droppedPseudoRows } = parseRealFeed();
    expect(droppedPseudoRows).toHaveLength(5);
    expect(events).toHaveLength(374);
    expect(events.length + droppedPseudoRows.length).toBe(379);
  });

  it("drops precisely the 5 known pseudo rows and nothing else", () => {
    const { droppedPseudoRows } = parseRealFeed();
    const trimmed = droppedPseudoRows.map((raw) => raw.trim()).sort();
    expect(trimmed).toEqual(
      [
        "**Last Update (IE Calendar)**",
        "APPLIED BUSINESS MATHEMATICS   Smowl Check-Test: Multiattempt, you can use it to test Smowl before any Exam or Quiz",
        "APPLIED BUSINESS MATHEMATICS   Test the download and upload of Excel files",
        "BBADBA SEP-2025COST-NBDA.1.M.A: Cost Accounting BBADBA & BBABCSAI T-04.01",
        "BBADBA SEP-2025COST-NBDA.1.M.A: My Accounting Lab - Prof. Rui Oliveira",
      ].sort(),
    );
  });

  /**
   * 🚨 THE TRAP, on real data. `APPLIED BUSINESS MATHEMATICS` carries **four**
   * rows: two proctoring/upload checks that must go, and two genuine events that
   * must stay. A filter keyed on "no course name" misses the pseudo pair; one
   * keyed on the course name eats the real pair. Only a filter keyed on each
   * pseudo row's own signature gets all four right.
   */
  it("handles all 4 APPLIED BUSINESS MATHEMATICS rows correctly", () => {
    const { events, droppedPseudoRows } = parseRealFeed();
    const isAbm = (raw: string) => raw.includes("APPLIED BUSINESS MATHEMATICS");

    const survivors = events.filter((event) => isAbm(event.rawSummary));
    const dropped = droppedPseudoRows.filter(isAbm);

    expect(survivors).toHaveLength(2);
    expect(dropped).toHaveLength(2);
    expect(survivors.length + dropped.length).toBe(4);

    expect(survivors.map((event) => event.rawSummary.trim()).sort()).toEqual([
      "APPLIED BUSINESS MATHEMATICS   Extra T-05.01",
      "APPLIED BUSINESS MATHEMATICS   Final EXAM Retake June ABM30",
    ]);
    // Both survivors are on 2026-06-02 — a June re-sit of a spring course.
    for (const survivor of survivors) {
      expect(survivor.occurrences[0]?.startsAtUtc.slice(0, 10)).toBe("2026-06-02");
    }
    // ...and the course prefix did NOT save the two pseudo rows filed under it.
    expect(dropped.every((raw) => /smowl|test the (?:download|upload)/i.test(raw))).toBe(true);
  });

  it("has zero VTIMEZONE and 738 naked TZIDs — the IANA fallback is the primary path", () => {
    const feed = REAL_FEED as string;
    expect(feed.match(/BEGIN:VTIMEZONE/g)).toBeNull();
    expect(feed.match(/TZID=Europe\/Madrid/g)).toHaveLength(738);
    expect(feed.match(/BEGIN:VEVENT/g)).toHaveLength(379);

    // Every surviving event still resolved to a real UTC instant, which is only
    // possible through `Intl` — there is no VTIMEZONE to fall back on.
    const { events } = parseRealFeed();
    for (const event of events) {
      for (const occurrence of event.occurrences) {
        expect(Number.isNaN(Date.parse(occurrence.startsAtUtc))).toBe(false);
      }
    }
  });

  it("carries no recurrence and no upstream cancellations", () => {
    const feed = REAL_FEED as string;
    expect(feed.match(/^RRULE/gm)).toBeNull();
    expect(feed.match(/^EXDATE/gm)).toBeNull();
    expect(feed.match(/^RECURRENCE-ID/gm)).toBeNull();
    expect(feed.match(/STATUS:CANCELLED/g)).toBeNull();
    expect(feed.match(/STATUS:CONFIRMED/g)).toHaveLength(379);

    // Which is what makes §3.6 tombstones the ONLY cancellation signal.
    const { events } = parseRealFeed();
    expect(events.every((event) => event.rrule === undefined)).toBe(true);
    expect(events.every((event) => event.occurrences.every((o) => o.status === "confirmed"))).toBe(
      true,
    );
  });

  it("parses the 20 all-day rows that carry no VALUE=DATE", () => {
    const feed = REAL_FEED as string;
    // The RFC form is entirely absent; all 20 use the TZID + DURATION:P1D shape.
    expect(feed.match(/VALUE=DATE/g)).toBeNull();
    expect(feed.match(/^DURATION:P1D/gm)).toHaveLength(20);

    const { events } = parseRealFeed();
    const allDay = events.filter((event) => event.occurrences.some((o) => o.allDay));
    expect(allDay).toHaveLength(20);
  });

  it("finds DESCRIPTION present on every event but blank after trim on all but one", () => {
    const feed = REAL_FEED as string;
    expect(feed.match(/^DESCRIPTION/gm)).toHaveLength(379);

    // ⚠ The documented past bug: `if (description)` is truthy 379/379. The one
    // non-blank value belongs to the `Last Update` pseudo row, which is filtered,
    // so *no surviving event* carries a description.
    const { events } = parseRealFeed();
    expect(events.filter((event) => event.description !== undefined)).toHaveLength(0);
  });

  /**
   * The headline claim of §5.1b correction 3: the normalizer is not cosmetic.
   * 9 apparent name variants in the fall term collapse to exactly 7 courses.
   */
  it("collapses the fall term to exactly 7 courses", () => {
    const { events } = parseRealFeed();
    const grouped = groupFallByCourse(events);
    expect(grouped.size).toBe(7);
    expect([...grouped.keys()].sort()).toEqual([
      "ALGORITHMS & DATA STRUCTURES",
      "ATTENTION MANAGEMENT FOR LEARNING",
      "BUILDING POWERFUL RELATIONSHIPS",
      "MARKETING MANAGEMENT",
      "MATHEMATICS FOR DATA MANAGEMENT AND ANALYSIS",
      "PROBABILITY & STATISTICS FOR DATA MANAGEMENT AND ANALYSIS",
      "PROGRAMMING FOR DATA MANAGEMENT & ANALYSIS",
    ]);
  });

  it("reproduces the verified per-course event and session counts", () => {
    const { events } = parseRealFeed();
    const grouped = groupFallByCourse(events);
    const actual = Object.fromEntries(
      [...grouped].map(([name, entry]) => [name, [entry.events, entry.maxSession]]),
    );

    // 🚨 Event count ≠ session count. The last three courses use ranged
    // `(Ses. N-M)` rows, so per-session logic that ignores ranges undercounts
    // them by nearly half.
    expect(actual).toEqual({
      "ALGORITHMS & DATA STRUCTURES": [30, 30],
      "MATHEMATICS FOR DATA MANAGEMENT AND ANALYSIS": [30, 30],
      "PROGRAMMING FOR DATA MANAGEMENT & ANALYSIS": [30, 30],
      "PROBABILITY & STATISTICS FOR DATA MANAGEMENT AND ANALYSIS": [34, 35],
      "MARKETING MANAGEMENT": [15, 20],
      "BUILDING POWERFUL RELATIONSHIPS": [13, 25],
      "ATTENTION MANAGEMENT FOR LEARNING": [2, 2],
    });
  });

  it("proves MARKETING MANAGEMENT fragments 10 + 3 + 2 before normalisation", () => {
    const { events } = parseRealFeed();
    const marketing = events.filter(
      (event) =>
        event.courseHint === "MARKETING MANAGEMENT" &&
        (event.occurrences[0]?.startsAtUtc ?? "") >= FALL_FROM,
    );
    expect(marketing).toHaveLength(15);

    // The naive course key: everything before the session token, trimmed but
    // NOT junk-stripped. That is what a group-by looks like before §5.1b, and it
    // is where the fragmentation actually lives — the leaked `|` / `, null`
    // fields sit *after* the course name, so splitting on 2+ spaces alone hides
    // the problem rather than causing it.
    const rawVariants = new Map<string, number>();
    for (const event of marketing) {
      const rawKey = event.rawSummary.split(/\(\s*ses\.?\s*\d/i)[0]?.trim() ?? "";
      rawVariants.set(rawKey, (rawVariants.get(rawKey) ?? 0) + 1);
    }

    expect([...rawVariants.keys()].sort()).toEqual([
      "MARKETING MANAGEMENT",
      "MARKETING MANAGEMENT   |",
      "MARKETING MANAGEMENT   | | , null",
    ]);
    expect(rawVariants.get("MARKETING MANAGEMENT")).toBe(10);
    expect(rawVariants.get("MARKETING MANAGEMENT   |")).toBe(3);
    expect(rawVariants.get("MARKETING MANAGEMENT   | | , null")).toBe(2);
    expect(rawVariants.size).toBe(3);

    // The un-normalised group-by keeps only the largest variant: 5 of 15 events
    // lost, and max session understated.
    const largest = Math.max(...rawVariants.values());
    expect(marketing.length - largest).toBe(5);
  });

  /**
   * 🚨 Session numbers are NOT monotonic with date. Ordering by date to find
   * "the last session" is wrong on real data, which is why detection keys on the
   * session number.
   */
  it("contains a course whose session numbers run backwards in time", () => {
    const { events } = parseRealFeed();
    const corporateFinance = events
      .filter((event) => event.courseHint === "CORPORATE FINANCE" && event.sessionTo !== undefined)
      .sort((a, b) =>
        (a.occurrences[0]?.startsAtUtc ?? "").localeCompare(b.occurrences[0]?.startsAtUtc ?? ""),
      );

    let sawInversion = false;
    for (let index = 1; index < corporateFinance.length; index += 1) {
      const previous = corporateFinance[index - 1]?.sessionTo ?? 0;
      const current = corporateFinance[index]?.sessionTo ?? 0;
      if (current < previous) {
        sawInversion = true;
        break;
      }
    }
    expect(sawInversion).toBe(true);
  });

  /**
   * Step 3 in isolation, end to end on real data.
   *
   * ⚠ CORRECTED 2026-07-18 (Gate 2). The previous docstring claimed
   * "`total_sessions` is unseeded for them", which is **false** — verified
   * against the live database, all 7 fall courses carry a seeded
   * `total_sessions` (ADS 30, MDMA 30, PDMA 30, P&S 35, MM 20, BPR 25, AML 2).
   * `assessments` really is 0 rows, so step 2 is genuinely dead.
   *
   * This test therefore does not describe production behaviour: it pins step 3
   * by **deliberately withholding** the oracle, which is a valid unit of
   * coverage but is not "what the app does". A caller that passes the seeded
   * column — as the sync engine will — resolves through step 1 instead. What
   * the two paths return is asserted directly in the next test.
   */
  it("resolves all 7 fall courses through the max-session fallback when no oracle is passed", () => {
    const { events } = parseRealFeed();
    const grouped = groupFallByCourse(events);

    for (const [courseName, expected] of grouped) {
      const courseEvents: ExamCandidateEvent[] = events
        .filter((event) => {
          const startsAt = event.occurrences[0]?.startsAtUtc ?? "";
          return event.courseHint === courseName && startsAt >= FALL_FROM && startsAt <= FALL_TO;
        })
        .flatMap((event) => {
          const normalized = normalizeSummary(event.rawSummary);
          return normalized
            ? [
                {
                  uid: event.uid,
                  startsAtUtc: event.occurrences[0]?.startsAtUtc ?? "",
                  summary: normalized,
                },
              ]
            : [];
        });

      // Oracle deliberately withheld to pin step 3 — NOT a claim that the
      // column is empty. See the docstring above.
      const detection = detectExam({ events: courseEvents });
      expect(detection.outcome).toBe("found");
      if (detection.outcome === "found") {
        expect(detection.source).toBe("feed_max_session");
        expect(detection.sessionNumber).toBe(expected.maxSession);
        // No 2025/26 semesters row is seeded, so every candidate is `unbounded`
        // rather than discarded (guard 2's skip-and-flag form).
        expect(detection.flags.unbounded).toBe(true);
      }
    }
  });

  /**
   * 🚨 THE CIRCULARITY, made explicit and executable.
   *
   * Recorded 2026-07-18 (Gate 2). `courses.total_sessions` IS seeded for all 7
   * fall courses — but Agent 0 seeded it **from feed-derived session counts**
   * (`packages/db/supabase/seed/fall-2026-courses.sql` states its source as "the
   * live IE ICS feed by the §5.1b normalizer"), not from any syllabus. All 3
   * syllabi on disk are 2025-26 documents matching none of these 7 courses.
   *
   * So step 1 (the "syllabus oracle") and step 3 (the feed fallback) are reading
   * **the same underlying number by two different routes**, and this test proves
   * it: the seeded values are byte-identical to `max(sessionTo)` for 7 of 7.
   *
   * The consequence for the M1 DoD clause "the syllabus-first exam chain picks a
   * real exam date for 7 of 7 fall courses": it is satisfied **circularly**.
   * Routing through step 1 yields the same date as step 3 by construction, so it
   * is not evidence that the syllabus path works. That path stays unproven until
   * a real fall-2026 syllabus — a number with independent provenance — exists.
   * `courses` has no `source` column, so the provenance is not distinguishable
   * at runtime either.
   *
   * This test must KEEP PASSING as long as the seed is feed-derived. If a real
   * syllabus later disagrees with the feed, it will fail — and that failure is
   * the signal that the oracle has finally become independent. Update it then.
   */
  it("proves step 1 and step 3 are the same number by two routes (seed is feed-derived)", () => {
    // Verbatim from the live database, 2026-07-18.
    const SEEDED_TOTAL_SESSIONS: Readonly<Record<string, number>> = {
      "ALGORITHMS & DATA STRUCTURES": 30,
      "MATHEMATICS FOR DATA MANAGEMENT AND ANALYSIS": 30,
      "PROGRAMMING FOR DATA MANAGEMENT & ANALYSIS": 30,
      "PROBABILITY & STATISTICS FOR DATA MANAGEMENT AND ANALYSIS": 35,
      "MARKETING MANAGEMENT": 20,
      "BUILDING POWERFUL RELATIONSHIPS": 25,
      "ATTENTION MANAGEMENT FOR LEARNING": 2,
    };

    const { events } = parseRealFeed();
    const grouped = groupFallByCourse(events);

    for (const [courseName, entry] of grouped) {
      const seeded = SEEDED_TOTAL_SESSIONS[courseName];
      expect(seeded, `no seeded total_sessions recorded for ${courseName}`).toBeDefined();
      // The whole point: the "syllabus" oracle equals the feed's max session.
      expect(seeded, `${courseName}: seeded total_sessions vs feed max(sessionTo)`).toBe(
        entry.maxSession,
      );
    }
    expect(Object.keys(SEEDED_TOTAL_SESSIONS).sort()).toEqual([...grouped.keys()].sort());
  });

  /**
   * The same 7 courses run through the chain WITH the seeded oracle — i.e. what
   * the sync engine will actually do. Every course resolves `found` via step 1,
   * on the identical date step 3 produced above.
   *
   * Read together with the previous test, this is the honest statement of the
   * DoD: 7 of 7 do resolve through the syllabus-first path, and that fact
   * carries no independent information, because the oracle was seeded from the
   * feed it is being checked against.
   */
  it("resolves 7 of 7 via step 1 — on the same dates step 3 picked", () => {
    const { events } = parseRealFeed();
    const grouped = groupFallByCourse(events);

    for (const [courseName, entry] of grouped) {
      const courseEvents: ExamCandidateEvent[] = events
        .filter((event) => {
          const startsAt = event.occurrences[0]?.startsAtUtc ?? "";
          return event.courseHint === courseName && startsAt >= FALL_FROM && startsAt <= FALL_TO;
        })
        .flatMap((event) => {
          const normalized = normalizeSummary(event.rawSummary);
          return normalized
            ? [
                {
                  uid: event.uid,
                  startsAtUtc: event.occurrences[0]?.startsAtUtc ?? "",
                  summary: normalized,
                },
              ]
            : [];
        });

      const viaSyllabus = detectExam({ events: courseEvents, totalSessions: entry.maxSession });
      const viaFallback = detectExam({ events: courseEvents });

      expect(viaSyllabus.outcome, courseName).toBe("found");
      if (viaSyllabus.outcome !== "found" || viaFallback.outcome !== "found") continue;

      expect(viaSyllabus.source).toBe("syllabus_total_sessions");
      expect(viaFallback.source).toBe("feed_max_session");
      // Different source, identical answer — that is the circularity.
      expect(viaSyllabus.sessionNumber).toBe(viaFallback.sessionNumber);
      expect(viaSyllabus.uid).toBe(viaFallback.uid);
      expect(viaSyllabus.startsAtUtc).toBe(viaFallback.startsAtUtc);
    }
  });
});

/**
 * Guards the guard: proves the suite survives the fixture being absent.
 *
 * This runs on CI, where `LOCAL_FEEDS` is `{}`. It asserts the *mechanism* — a
 * glob that matches nothing produces an empty record, and `hasFeed` is derived
 * from exactly that — so the skip cannot silently rot into "the assertions never
 * ran anywhere".
 */
describe("the Tier-2 skip path", () => {
  it("derives its skip from a glob that yields {} when the file is absent", () => {
    const absent = import.meta.glob("../../../../apps/web/.local-fixtures/calendar/*.absent", {
      query: "?raw",
      import: "default",
      eager: true,
    });
    expect(Object.keys(absent)).toHaveLength(0);
    // Same derivation as `hasFeed`, applied to a guaranteed-missing pattern.
    const wouldSkip = !(typeof Object.values(absent)[0] === "string");
    expect(wouldSkip).toBe(true);
  });

  it("reports whether the real fixture is present in this environment", () => {
    // Deliberately not an assertion on `hasFeed`: true locally, false on CI, and
    // both are correct. Asserting either way would break one of the two.
    expect(typeof hasFeed).toBe("boolean");
  });
});
