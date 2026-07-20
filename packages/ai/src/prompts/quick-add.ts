/**
 * The `quick-add` prompt (PLAN.md §Deadlines & Calendar Hub §6).
 *
 * One utterance in, one proposed calendar entry out — always through the confirm card,
 * never straight to the calendar. The prompt's whole job is grounding: the model is handed
 * today's date, the weekday, the timezone and the user's course list, so "next friday" and
 * "ML" resolve against facts the caller supplied rather than against anything the model
 * believes. `packages/ai` cannot read a clock — no I/O, no `process.env` — and that
 * limitation is kept as a feature: a caller that must inject "today" is a caller that can
 * inject the USER'S today, in the user's timezone, which is the only today that makes
 * "friday" mean the right day for someone whose deadline is at 23:59 Madrid time.
 *
 * Most of the field-level rules live as `.describe()` on `quickAddParseSchema` — per
 * `schemas/index.ts`, descriptions are prompt surface. What lives here is the stance
 * (propose, never decide) and the date discipline, because "never invent a date" is the
 * rule most worth stating twice.
 */

import { definePrompt } from "./define";

export const QUICK_ADD_SYSTEM = `You turn one short line typed by a university student into a proposed calendar entry — a deadline, a class, or an event.

You PROPOSE, you never decide. Everything you return is shown to the student on a confirm card, editable, before anything is saved. That changes what a good answer looks like: a blank field with an honest note beats a plausible guess, because the student will correct a blank but may not catch a guess.

Date discipline, in order:
1. You are told today's date, the weekday it falls on, and the timezone. Every date and time you return is in that timezone.
2. Resolve relative phrases against that today. "friday" or "next friday" means the next Friday strictly after today; "tomorrow" is today plus one day; "March 3" with no year means the next March 3 in the future.
3. If the utterance establishes no date, or the phrase is genuinely ambiguous, return date: null and name the problem in ambiguity. NEVER invent a date. A deadline saved to the wrong day is the worst possible outcome, and it is not yours to risk — the student can fill a blank in one tap.

Courses: you are given the student's course list with ids. A course mention may be an abbreviation or a fragment ("ML", "econ"). Pick the one clear match and copy its id exactly; if no listed course clearly matches, or two do, use null and say so in ambiguity. Never output an id that is not on the list.

Only extract what the utterance actually says. No time mentioned means time: null (all-day). No weight stated means weightPercent: null. Report your overall confidence honestly — below 0.6 the app discards your parse and shows an empty form instead.`;

export const quickAddPrompt = definePrompt<{
  utterance: string;
  today: string;
  weekday: string;
  timezone: string;
  courseList: string;
}>({
  id: "quick-add",
  // v2, not v1: five `quick-add@1` rows already existed in `ai_generations`
  // (2026-07-19, a Wave 5 working-tree experiment whose ~27-token render was a
  // different text — this template measures ~570 input tokens). The five-column
  // stamp cannot tell two texts apart at the same id@version, so this text takes
  // the next version rather than colliding with rows it did not produce.
  version: 2,
  description:
    "Natural-language quick-add: one utterance plus today's date, timezone and the course list, parsed into a proposed calendar entry for the confirm card (PLAN §Calendar §6).",
  render: ({
    utterance,
    today,
    weekday,
    timezone,
    courseList,
  }) => `Today is ${weekday}, ${today}, in the ${timezone} timezone. All dates and times are in that timezone.

## The student's courses

${courseList}

## What the student typed

"${utterance}"

Return the proposed entry.`,
});
