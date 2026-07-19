/**
 * The §5.1b `SUMMARY` normalizer for the IE agenda feed.
 *
 * The feed prefixes every event title with its course name and then appends
 * whatever the upstream system happened to leak — empty backend fields render
 * as `|` and `, null`, session tokens appear as `(Ses. N)` or `(Ses. N-M)`, and
 * the room is duplicated from `LOCATION`. Grammar (multi-space delimited, every
 * field optional):
 *
 * ```
 * <COURSE NAME>␣␣␣[<descriptor / leaked junk>]␣[(Ses. N)|(Ses. N-M)]␣[<room or modality>]
 * ```
 *
 * **This normalizer is not cosmetic.** Verified 2026-07-18: `MARKETING
 * MANAGEMENT` fragments across three raw variants holding 10 + 3 + 2 events, so
 * an un-normalised group-by loses 5 of its 15 events *and* understates its max
 * session — which makes exam detection (§5.1b) wrong, not just untidy.
 */

/** How the feed labels an event relative to a course's regular session plan. */
export type SessionDescriptor = "regular" | "extra" | "retake" | "final_exam";

/** Context the normalizer needs from the rest of the `VEVENT`. */
export interface NormalizeSummaryOptions {
  /**
   * The event's `LOCATION`, so the room echo can be removed from the title.
   *
   * Omitting it is safe but weaker: the room-code and modality patterns still
   * fire, but a site-specific room string that matches neither would survive.
   */
  location?: string;
}

export interface NormalizedSummary {
  /** Verbatim `SUMMARY`, so the normalizer can be re-run after a rule fix. */
  rawSummary: string;
  /** First multi-space segment, junk-stripped — the course-matching surface. */
  courseName: string;
  /**
   * `SUMMARY` minus the course prefix, session token, junk and room/modality
   * echo.
   *
   * **Legitimately empty** on most rows: for a clean IE row the room was the
   * only thing left, and the room belongs to `location`. Render it through
   * `occurrenceLabel` rather than reading it directly.
   */
  title: string;
  /** `(Ses. 4)` → 4. `(Ses. 4-5)` → 4. Undefined when the feed carries no token. */
  sessionFrom?: number;
  /** `(Ses. 4)` → 4. `(Ses. 4-5)` → **5**. Ranges are real; see below. */
  sessionTo?: number;
  descriptor: SessionDescriptor;
}

/**
 * A row the feed carries that is not a calendar event at all.
 *
 * Verified 2026-07-18: there are exactly **5**, and the naive filters both fail.
 * Keyed on each row's own signature — see `PSEUDO_ROW_SIGNATURES`.
 */
export interface PseudoRow {
  rawSummary: string;
  reason: PseudoRowReason;
}

export type PseudoRowReason = "last_update" | "lms_course_shell" | "proctoring_check";

/** Splits on runs of 2+ spaces — the feed's actual field delimiter. */
const FIELD_DELIMITER = /\s{2,}/;

/**
 * `(Ses. N)` and `(Ses. N-M)`.
 *
 * The range form is **real and load-bearing**: one calendar event can cover two
 * taught sessions (`BUILDING POWERFUL RELATIONSHIPS  (Ses. 24-25)`). Three of
 * the seven fall-2026 courses use ranges, and per-session logic that ignores
 * them undercounts taught sessions by nearly half on those courses.
 */
const SESSION_TOKEN = /\(\s*ses\.?\s*(\d+)\s*(?:-\s*(\d+)\s*)?\)/i;

/**
 * Room codes exactly as the feed writes them: `T-06.02`, `T-09.03A`, and the
 * two-room form `T-12.02|T-12.03` (the `|` is eaten by `JUNK_SEQUENCE` first,
 * leaving two space-separated codes, so this matches each one individually).
 */
const ROOM_CODE = /\bT-\d{2}\.\d{2}[A-Z]?\b/gi;

/**
 * The modality strings the feed puts where a room would otherwise go.
 *
 * Verified against all 20 distinct `LOCATION` values in the live feed: the
 * non-room ones are exactly `Asynchronous`, `Live online` and `IE TOWER`. The
 * others are defensive — a modality that reaches `title` is the same defect.
 *
 * ⚠ `ie tower` is matched as a *phrase*. A bare `\bie\b` would eat the `IE` of
 * `IE HUMANITIES`, which is a real course.
 */
const MODALITY = /\b(?:asynchronous|live online|online|remote|on campus|ie tower)\b/gi;

/**
 * Leaked-empty-backend-field junk: runs of `|` and `, null`, in any mix.
 *
 * Real examples this must reduce to nothing:
 *   `COST ACCOUNTING   |`
 *   `MARKETING MANAGEMENT   | | , null`
 *   `IE HUMANITIES   | | | , null, null`
 */
const JUNK_SEQUENCE = /(?:\s*(?:\||,\s*null\b))+/gi;

/**
 * The five pseudo/LMS rows, each keyed on **its own signature** rather than on
 * the presence or absence of a course prefix.
 *
 * 🚨 This is the trap, and both naive filters walk into it. `APPLIED BUSINESS
 * MATHEMATICS` carries **four** rows: two proctoring/upload checks that must be
 * dropped, and two genuine events (`Extra T-05.01`, `Final EXAM Retake June
 * ABM30`) that must survive. So:
 * - a filter keyed on "no course name" misses the two ABM pseudo rows, and
 * - a filter keyed on the course name eats two real events.
 *
 * Each predicate below therefore matches the *content* that makes a row
 * non-eventlike, never the course it is filed under.
 */
const PSEUDO_ROW_SIGNATURES: ReadonlyArray<{
  reason: PseudoRowReason;
  matches: (summary: string) => boolean;
}> = [
  {
    // `**Last Update (IE Calendar)**` — the feed's own generation stamp, and the
    // only row in the export carrying a non-blank DESCRIPTION.
    reason: "last_update",
    matches: (summary) => /^\*\*\s*last update\b/i.test(summary),
  },
  {
    // `BBADBA SEP-2025COST-NBDA.1.M.A: …` — an LMS course-shell row, not a
    // class. Note the two real ones begin with LEADING WHITESPACE, so the
    // caller must trim before testing (we do, below).
    reason: "lms_course_shell",
    matches: (summary) => /^[A-Z]{4,}\s+[A-Z]{3}-\d{4}[A-Z-]*\.[\dA-Z.]*\s*:/i.test(summary),
  },
  {
    // The two `APPLIED BUSINESS MATHEMATICS` rows: a Smowl proctoring check and
    // an Excel upload test. Both carry a real course prefix, which is exactly
    // why the signature has to be the check itself.
    reason: "proctoring_check",
    matches: (summary) =>
      /\bsmowl\b/i.test(summary) ||
      /\btest the (?:download|upload)\b/i.test(summary) ||
      /\bmultiattempt\b/i.test(summary),
  },
];

/**
 * Classifies a row as a pseudo/LMS row, or `null` when it is a real event.
 *
 * Leading whitespace is stripped first: two of the five pseudo rows begin with
 * spaces, so splitting on 2+ spaces without trimming yields an **empty** first
 * segment and a course name of `""`.
 */
export function classifyPseudoRow(rawSummary: string): PseudoRow | null {
  const summary = rawSummary.trim();
  if (summary.length === 0) {
    return null;
  }

  for (const signature of PSEUDO_ROW_SIGNATURES) {
    if (signature.matches(summary)) {
      return { rawSummary, reason: signature.reason };
    }
  }
  return null;
}

/** Collapses internal whitespace runs and trims — `A   B` → `A B`. */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Strips `|` / `, null` junk and collapses whitespace.
 *
 * Applied to the course name this is what merges `MARKETING MANAGEMENT`,
 * `MARKETING MANAGEMENT   |` and `MARKETING MANAGEMENT   | | , null` into one
 * course holding all 15 of its events.
 */
export function stripJunk(value: string): string {
  return collapseWhitespace(value.replace(JUNK_SEQUENCE, " "));
}

/** Escapes a literal for use inside a `RegExp` — `LOCATION` values contain `.`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Removes the room/modality echo from a title.
 *
 * 🚨 This is the fix for a defect that reached production data. §5.1b says the
 * room comes from `LOCATION`, *never* from `SUMMARY`, "where it is duplicated" —
 * but the normalizer only ever declined to *read* the room from `SUMMARY`; it
 * never *removed* it. Because the room is the last field of the grammar, on a
 * clean row it was the only thing left after the course prefix and the session
 * token came off, so it became the title. Measured on the 374 live rows before
 * this fix: 324 had `title` exactly equal to `location`, 367 contained it, and
 * 305 were a bare `T-NN.NN` room code. Every class in the calendar list rendered
 * as `T-06.02`.
 *
 * Removal is by three rules, in order:
 *  1. the row's own `LOCATION`, split on `|` (the feed's multi-room separator),
 *  2. any remaining room code, and
 *  3. any modality word.
 *
 * Rules 2 and 3 matter independently of rule 1: 5 rows carry a room in `SUMMARY`
 * while `LOCATION` is null, so keying only on `LOCATION` would leave those.
 *
 * What survives is genuine descriptive text (`Class Participation`, `Retake Exam
 * Corporate Finance June 2026`). When nothing survives the title is `""` and the
 * UI composes a label from the course and session instead — see
 * `occurrenceLabel`. `rawSummary` is untouched, so this is re-runnable.
 */
function stripLocationEcho(title: string, location: string | undefined): string {
  let result = title;

  for (const token of (location ?? "").split("|")) {
    const trimmed = token.trim();
    if (trimmed.length > 0) {
      result = result.replace(new RegExp(escapeRegExp(trimmed), "gi"), " ");
    }
  }

  result = result.replace(ROOM_CODE, " ").replace(MODALITY, " ");
  return collapseWhitespace(result);
}

/**
 * Classifies the descriptor from the summary's non-course remainder.
 *
 * Ordered deliberately: `Final EXAM Retake June ABM30` is a **retake**, so
 * retake must be tested before final-exam or the re-sit is filed as the final —
 * which is precisely the mistake guard 1 of the exam-detection fallback exists
 * to catch, and it is cheaper to not make it here.
 */
function classifyDescriptor(remainder: string): SessionDescriptor {
  if (/\b(?:retake|resit|convocatoria)\b/i.test(remainder)) {
    return "retake";
  }
  if (/\bfinal\s+exam\b/i.test(remainder)) {
    return "final_exam";
  }
  if (/\bextra\b/i.test(remainder)) {
    return "extra";
  }
  return "regular";
}

/**
 * Parses one `SUMMARY` into its §5.1b parts.
 *
 * Returns `null` for the 5 pseudo rows — callers filter on that. Use
 * `classifyPseudoRow` when the *reason* matters (diagnostics, sync reporting).
 *
 * The room is deliberately **not** taken from here: §5.1b says take it from
 * `LOCATION`, never from `SUMMARY`, where it is a duplicate and where
 * `Asynchronous` is a modality rather than a room.
 */
export function normalizeSummary(
  rawSummary: string,
  options: NormalizeSummaryOptions = {},
): NormalizedSummary | null {
  if (classifyPseudoRow(rawSummary)) {
    return null;
  }

  // Trim first: two pseudo rows and an unknown number of real ones carry
  // leading whitespace, which would otherwise produce an empty first segment.
  const summary = rawSummary.trim();
  const segments = summary.split(FIELD_DELIMITER);
  const courseName = stripJunk(segments[0] ?? "");
  const remainder = segments.slice(1).join(" ");

  const sessionMatch = SESSION_TOKEN.exec(summary);
  let sessionFrom: number | undefined;
  let sessionTo: number | undefined;
  if (sessionMatch) {
    const from = Number(sessionMatch[1]);
    // `(Ses. 4-5)` covers sessions 4 AND 5; `(Ses. 4)` covers only 4, so `to`
    // collapses onto `from` rather than being left undefined. Downstream
    // per-session logic can then always read the closed range [from, to].
    const to = sessionMatch[2] === undefined ? from : Number(sessionMatch[2]);
    if (Number.isFinite(from) && Number.isFinite(to)) {
      sessionFrom = from;
      sessionTo = Math.max(from, to);
    }
  }

  // The title is everything after the course name, minus the session token, the
  // junk, and — see `stripLocationEcho` — the room/modality echo. On a clean row
  // (`… (Ses. 4) T-03.01`) the room was ALL that was left, so before the echo
  // was stripped the title *was* the room code. It is now `""` there, and the UI
  // composes a label from course + session via `occurrenceLabel`.
  const title = stripLocationEcho(
    stripJunk(remainder.replace(SESSION_TOKEN, " ")),
    options.location,
  );

  const result: NormalizedSummary = {
    rawSummary,
    courseName,
    title,
    descriptor: classifyDescriptor(remainder),
  };
  if (sessionFrom !== undefined) {
    result.sessionFrom = sessionFrom;
  }
  if (sessionTo !== undefined) {
    result.sessionTo = sessionTo;
  }
  return result;
}

/** How a descriptor reads when it is all we have to label an event with. */
const DESCRIPTOR_LABEL: Record<SessionDescriptor, string> = {
  regular: "Class",
  extra: "Extra session",
  retake: "Retake exam",
  final_exam: "Final exam",
};

/**
 * The human-readable label for an event, for when `title` is legitimately empty.
 *
 * Most IE rows carry no descriptive text at all — the `SUMMARY` is course name +
 * session token + room, and the first two are structured fields while the third
 * belongs to `location`. So the label falls back through: explicit title →
 * session number(s) → descriptor → `"Class"`.
 *
 * The course name is deliberately **not** included: every surface that shows
 * this also shows the course separately, and repeating it reads as a stutter.
 */
export function occurrenceLabel(input: {
  title?: string | null;
  sessionFrom?: number | null;
  sessionTo?: number | null;
  descriptor?: SessionDescriptor | null;
}): string {
  const title = (input.title ?? "").trim();
  if (title.length > 0) {
    return title;
  }

  const { sessionFrom, sessionTo } = input;
  if (typeof sessionFrom === "number") {
    // An en dash, not a hyphen: `Sessions 24–25` is a range, and the feed's own
    // hyphen already reads as part of the room codes elsewhere in the UI.
    return typeof sessionTo === "number" && sessionTo > sessionFrom
      ? `Sessions ${sessionFrom}–${sessionTo}`
      : `Session ${sessionFrom}`;
  }

  return DESCRIPTOR_LABEL[input.descriptor ?? "regular"];
}

/**
 * Every session number an event covers, expanding `(Ses. N-M)` ranges.
 *
 * `(Ses. 24-25)` → `[24, 25]`. Any per-session logic (attendance, "sessions
 * taught so far", exam candidacy) must go through this, or it undercounts the
 * three fall courses that use ranged rows by nearly half.
 */
export function expandSessionRange(normalized: NormalizedSummary): number[] {
  const { sessionFrom, sessionTo } = normalized;
  if (sessionFrom === undefined || sessionTo === undefined) {
    return [];
  }
  const sessions: number[] = [];
  for (let session = sessionFrom; session <= sessionTo; session += 1) {
    sessions.push(session);
  }
  return sessions;
}
