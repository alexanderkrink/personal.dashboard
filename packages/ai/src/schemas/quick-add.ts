/**
 * The `quick-add` parse contract (PLAN.md §Deadlines & Calendar Hub §6).
 *
 * One short utterance — "ML assignment 3 due next friday 23:59" — becomes a *proposed*
 * calendar entry. Proposed is the load-bearing word: a deadline is date-critical data, one
 * of the two classes behind a mandatory human confirm (§2b), so nothing this schema
 * describes is ever written to the calendar. It pre-fills the confirm card and stops there.
 *
 * The shape is field-for-field with `quickAddSchema` (the structured form's contract in
 * `apps/web/src/lib/calendar/item-schemas.ts`) plus the two parse-only signals at the end
 * — `confidence` and `ambiguity` — which exist so the model can be honest instead of
 * fluent. That correspondence is what makes the §6 degrade path ("the structured form is
 * the fallback, not a separate feature") a `key` change rather than a mapping layer.
 *
 * ## Date discipline, structurally
 *
 * §6 diverges from the usual "required field" instinct in one place: `date` is NULLABLE.
 * The model receives today's date and timezone as explicit input and resolves relative
 * phrases against them — but an utterance that establishes no date ("essay soon", "after
 * the break") must yield `date: null` plus an `ambiguity` note, never a guess. A silently
 * invented date on a deadline is the single worst output this feature can produce, so
 * "I don't know" is a first-class answer with its own column, not a failure mode.
 *
 * Deliberately FLAT — one object, no unions, no nesting. The §2 ladder escalates this
 * cross-family onto Claude, whose grammar compiler rejected a two-level nest on the topic
 * schema with HTTP 400 (see `schemas/topics.ts`); a quick-add parse must never be the
 * call that rediscovers that ceiling.
 */

import { z } from "zod";

/**
 * The three things a calendar entry can be — mirrored from `calendar_items.kind`'s
 * user-facing subset, not imported: `packages/ai` must not depend on `packages/db`.
 */
export const QUICK_ADD_KINDS = ["deadline", "class", "event"] as const;

export const quickAddParseSchema = z.object({
  title: z
    .string()
    .min(1)
    .describe(
      "What the entry is called, taken from the utterance with due-date words stripped — 'ML assignment 3 due next friday' titles as 'ML assignment 3'. Keep the student's own wording; do not expand abbreviations they chose.",
    ),
  kind: z
    .enum(QUICK_ADD_KINDS)
    .describe(
      "'deadline' when something is due or must be handed in — the default reading for quick-add. 'class' only for a scheduled teaching session. 'event' for anything else that happens at a time (a meeting, an office-hours slot, a review session).",
    ),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .describe(
      "The calendar date, YYYY-MM-DD, in the user's timezone. Resolve relative phrases ('friday', 'tomorrow', 'next week monday') against the stated today. Use null when the utterance does not establish a date or the phrase is genuinely ambiguous — NEVER invent or guess one; a deadline on the wrong day is worse than a blank field the student fills in. When you use null, say why in `ambiguity`.",
    ),
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable()
    .describe(
      "The time of day, 24-hour HH:MM in the user's timezone — '23:59', '09:00'. null when the utterance names no time; null means all-day.",
    ),
  durationMinutes: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe(
      "How long it runs, in whole minutes, ONLY when the utterance states or clearly implies a duration ('2h meeting' is 120). null otherwise, and always null when time is null — an all-day entry has no duration.",
    ),
  courseId: z
    .string()
    .nullable()
    .describe(
      "The id of the course this belongs to, copied EXACTLY from the provided course list — a hint like 'ML' may match a course titled 'Machine Learning'. null when no listed course is a clear match. Never output an id that is not in the list.",
    ),
  weightPercent: z
    .number()
    .min(0)
    .max(100)
    .nullable()
    .describe(
      "The share of the course grade, as a number — 'worth 20%' is 20. ONLY when the utterance states it; null otherwise. Never infer a weight from the kind of assignment.",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "0..1, how sure you are of the parse as a whole. Be honest — below 0.6 the app discards this parse and shows the student an empty form, which is the right outcome for an utterance you could not really read.",
    ),
  ambiguity: z
    .string()
    .nullable()
    .describe(
      "One short sentence naming what the utterance left unresolvable — 'no date given', \"'friday' could be the 24th or the 31st\", 'two courses match ML'. The student reads this next to the pre-filled card. null when nothing was ambiguous.",
    ),
});

export type QuickAddParse = z.infer<typeof quickAddParseSchema>;
