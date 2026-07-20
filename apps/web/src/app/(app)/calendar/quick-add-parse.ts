"use server";

import { AIPausedError, parseQuickAdd } from "@study/ai";
import { wallClockAt } from "@study/core";
import { z } from "zod";
import { AINotConfiguredError, createStudyAIRuntime } from "@/lib/ai/runtime";
import { requireUserId } from "@/lib/auth/require-user";
import type { QUICK_ADD_FIELDS } from "@/lib/calendar/item-schemas";
import type { QuickAddParseState } from "@/lib/calendar/quick-add-parse-state";
import { createClient } from "@/lib/supabase/server";

/**
 * §6 steps 1–3: the natural-language parse behind quick-add.
 *
 * ## 🔒 This module proposes. It does not write.
 *
 * A deadline is date-critical data — one of the two classes PLAN §2b keeps behind a
 * mandatory human confirm — so the parse's entire authority is to pre-fill the confirm
 * card. The write lives in `createQuickAddItem` (item-actions.ts), which takes the
 * card's own `FormData`: an input only a human submit produces, validated by
 * `quickAddSchema` on arrival like any hand-typed entry. There is no code path from a
 * `QuickAddParse` to an insert, and `quick-add-parse.test.ts` pins that — it was run
 * red against a variant of this action that auto-added on `confidence >= 0.9`, which
 * is exactly the shortcut this comment exists to keep out.
 *
 * ## What the parse is given, and why the caller computes "today"
 *
 * `packages/ai` cannot read a clock, so this action injects today's date and weekday
 * **computed in `profiles.timezone`** — the same §3.4 discipline as every other
 * calendar write. "Friday" typed at 00:30 Madrid time must resolve against Madrid's
 * today, not UTC's yesterday.
 *
 * ## Degrading (§6 step 3)
 *
 * `confidence < 0.6`, a dead-letter, a paused/unconfigured runtime, or a transport
 * failure all land in the same place: the structured form, EMPTY, with one sentence
 * saying why. The form is the fallback, not a separate feature — and a parse the app
 * does not trust must not leak plausible-looking fields onto the card either, which is
 * why `fallback` carries a message and nothing else.
 */

const FALLBACK_UNREADABLE = "Couldn’t read that one. The form below is all yours.";
const FALLBACK_UNAVAILABLE = "The parser isn’t available right now — the form below still works.";
const FALLBACK_LOW_CONFIDENCE =
  "Not sure enough about that reading to pre-fill anything. The form below is all yours.";
const FALLBACK_TIMEZONE =
  "Your timezone setting isn’t one we recognise, so relative dates can’t be resolved. Use the form below.";

/**
 * §6 step 3's threshold, verbatim: below this the parse is discarded and the card
 * arrives empty. The prompt tells the model the number so its self-report means
 * something.
 */
const MIN_CONFIDENCE = 0.6;

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const utteranceSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(
    z.string().min(3, "Say a little more than that.").max(300, "Keep it under 300 characters."),
  );

function fallback(message: string): QuickAddParseState {
  return { status: "fallback", message };
}

export async function parseQuickAddUtterance(
  _previous: QuickAddParseState,
  formData: FormData,
): Promise<QuickAddParseState> {
  const utterance = utteranceSchema.safeParse(formData.get("utterance"));
  if (!utterance.success) {
    return fallback(utterance.error.issues[0]?.message ?? FALLBACK_UNREADABLE);
  }

  const supabase = await createClient();
  const userId = await requireUserId(supabase);

  const [profile, courses] = await Promise.all([
    supabase.from("profiles").select("timezone").maybeSingle(),
    supabase.from("courses").select("id, title").eq("archived", false).order("title", {
      ascending: true,
    }),
  ]);
  const timezone = profile.data?.timezone ?? "Europe/Madrid";
  const courseList = courses.data ?? [];

  // Today, in the USER'S timezone. `wallClockAt` throws on a tzid the platform
  // doesn't know — same failure `createQuickAddItem` turns into a sentence, so the
  // parse degrades with the same honesty rather than resolving "friday" against a
  // wrong clock.
  let today: string;
  let weekday: string;
  try {
    const wall = wallClockAt(Date.now(), timezone);
    today = `${String(wall.year).padStart(4, "0")}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;
    weekday =
      WEEKDAY_NAMES[new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay()] ??
      "unknown";
  } catch {
    return fallback(FALLBACK_TIMEZONE);
  }

  let result: Awaited<ReturnType<typeof parseQuickAdd>>;
  try {
    const runtime = createStudyAIRuntime({ userId });
    result = await parseQuickAdd({
      runtime,
      utterance: utterance.data,
      today,
      weekday,
      timezone,
      courses: courseList,
    });
  } catch (error) {
    // Paused, unconfigured, or a transport failure — §6 step 3 makes no distinction
    // the student can act on differently: every one degrades to the empty form. A
    // human is mid-gesture here; a 500 would eat their utterance for nothing.
    if (error instanceof AIPausedError || error instanceof AINotConfiguredError) {
      return fallback(FALLBACK_UNAVAILABLE);
    }
    return fallback(FALLBACK_UNAVAILABLE);
  }

  if (result.status === "dead-letter") return fallback(FALLBACK_UNREADABLE);

  const value = result.value;

  // §6 step 3: an untrusted parse yields the SAME card, EMPTY. Returning `fallback`
  // rather than a stripped-down `parsed` is deliberate — the type carries no values,
  // so a low-confidence guess cannot half-leak onto the card.
  if (value.confidence < MIN_CONFIDENCE) return fallback(FALLBACK_LOW_CONFIDENCE);

  // `satisfies` against `QUICK_ADD_FIELDS` keeps the proposal and the form from
  // drifting: every field the card renders is populated here, absent-as-`""` exactly
  // the way `readFormValues` and `quickAddSchema`'s blankToNull expect.
  const values = {
    title: value.title,
    kind: value.kind,
    date: value.date ?? "",
    time: value.time ?? "",
    durationMinutes: value.durationMinutes === null ? "" : String(value.durationMinutes),
    courseId: value.courseId ?? "",
    weightPercent: value.weightPercent === null ? "" : String(value.weightPercent),
  } satisfies Record<(typeof QUICK_ADD_FIELDS)[number], string>;

  return {
    status: "parsed",
    values,
    note: value.ambiguity,
    token: crypto.randomUUID(),
  };
}

/**
 * The course list for the global (⌘K) quick-add dialog, which unlike the calendar page
 * has no Server Component to hand it props. Read-only, RLS-scoped.
 */
export async function listQuickAddCourses(): Promise<{ id: string; title: string }[]> {
  const supabase = await createClient();
  await requireUserId(supabase);
  const { data } = await supabase
    .from("courses")
    .select("id, title")
    .eq("archived", false)
    .order("title", { ascending: true });
  return data ?? [];
}
