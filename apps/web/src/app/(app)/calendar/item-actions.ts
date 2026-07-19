"use server";

import { wallClockToUtcIso } from "@study/core";
import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth/require-user";
import {
  assignCourseSchema,
  examDecisionSchema,
  occurrenceIdSchema,
  QUICK_ADD_FIELDS,
  quickAddSchema,
  weightOverrideSchema,
} from "@/lib/calendar/item-schemas";
import { type FormState, formError, toFormState } from "@/lib/forms/form-state";
import { readFormValues } from "@/lib/forms/form-values";
import { createClient } from "@/lib/supabase/server";
import { withLockedField } from "@/server/calendar/diff";
import { orderExamPatches, planExamDecision } from "@/server/calendar/exam-decision";

/**
 * Writes against `calendar_items` / `calendar_occurrences` that a *user* makes.
 *
 * Every one of these runs through `createClient()` — the request-scoped client,
 * where RLS answers "is this row yours?". None of them takes the admin client:
 * that bypasses RLS and belongs only to the background sync path, and handing it
 * an id chosen by the caller is the confused-deputy hole this file exists on the
 * right side of.
 */

const SAVE_FAILED = "That didn’t save. Try again — nothing you typed was lost.";
const NOT_FOUND = "That entry no longer exists. It may have been removed by a sync.";

/**
 * Postgres `unique_violation`. Surfaced by PostgREST verbatim in `error.code`.
 *
 * The only unique key a user write can realistically collide with on
 * `calendar_items` is `calendar_items_one_exam_per_course` — the one-exam-per-
 * course invariant — so it is worth its own sentence rather than the generic
 * "that didn't save".
 */
const UNIQUE_VIOLATION = "23505";

const EXAM_RACE_LOST =
  "Another change set this course’s exam date first. Reload to see the current one, then try again.";

const CLEARED = Object.fromEntries(QUICK_ADD_FIELDS.map((field) => [field, ""]));

/* -------------------------------------------------------------------------- */
/* §5.1 step 4 — assign an Unassigned group to a course                       */
/* -------------------------------------------------------------------------- */

/**
 * Files a whole course-name pattern under a course.
 *
 * Three things happen, and **all three are the point**:
 *
 * 1. Every currently-unassigned item whose hint matches gets `course_id`.
 * 2. `course_id` is added to each one's `user_locked_fields`, so the next sync
 *    cannot re-derive it back to null. §5.1: *"manual assignment locks
 *    `course_id` against sync"*. Agent 2 built the lock enforcement; until now
 *    nothing wrote a lock, so this is the first caller.
 * 3. A `course_matchers` row is written from the matched text, so **future**
 *    events with the same prefix link themselves — §5.1's *"the same feed
 *    pattern auto-links forever after"*. Without this the user would refile the
 *    same course every time the feed published another session.
 *
 * Step 3 without step 2 would still leave the existing rows to be re-matched by
 * the next sync; step 2 without step 3 would fix today and lose tomorrow. The
 * combination is what makes one click permanent.
 */
export async function assignCourse(_previous: FormState, formData: FormData): Promise<FormState> {
  const parsed = assignCourseSchema.safeParse({
    pattern: formData.get("pattern"),
    courseId: formData.get("courseId"),
  });
  if (!parsed.success) return toFormState(parsed.error);

  const supabase = await createClient();
  const userId = await requireUserId(supabase);

  // RLS scopes this to the user, and the composite (course_id, user_id) FK would
  // reject a foreign course anyway — but failing here produces a sentence rather
  // than a constraint violation.
  const course = await supabase
    .from("courses")
    .select("id, title")
    .eq("id", parsed.data.courseId)
    .maybeSingle();
  if (course.error) return formError(SAVE_FAILED);
  if (!course.data) return formError("That course no longer exists.");

  // Only unassigned rows. An item the user already filed elsewhere is not
  // re-filed by a bulk pattern assign — that would silently undo a more specific
  // decision with a broader one.
  const items = await supabase
    .from("calendar_items")
    .select("id, raw_summary, title, user_locked_fields")
    .is("course_id", null);
  if (items.error) return formError(SAVE_FAILED);

  const needle = parsed.data.pattern.toLowerCase();
  const matching = (items.data ?? []).filter((item) =>
    `${item.raw_summary ?? ""} ${item.title}`.toLowerCase().includes(needle),
  );

  for (const item of matching) {
    const { error } = await supabase
      .from("calendar_items")
      .update({
        course_id: parsed.data.courseId,
        user_locked_fields: withLockedField(item.user_locked_fields, "course_id"),
      })
      .eq("id", item.id);
    if (error) return formError(SAVE_FAILED);
  }

  // The learned rule. Written even when nothing matched right now: the user is
  // stating an intent about the feed, and a pattern that matches nothing today
  // is exactly the one that will match next term's first session.
  const matcher = await supabase.from("course_matchers").insert({
    user_id: userId,
    course_id: parsed.data.courseId,
    pattern: parsed.data.pattern,
  });
  if (matcher.error) return formError(SAVE_FAILED);

  revalidatePath("/calendar");
  revalidatePath("/");
  return {
    status: "success",
    message: `${matching.length} ${matching.length === 1 ? "entry" : "entries"} filed under ${course.data.title}. New ones matching “${parsed.data.pattern}” will link themselves.`,
  };
}

/* -------------------------------------------------------------------------- */
/* §7 part 3 — the checkbox and the inline weight override                    */
/* -------------------------------------------------------------------------- */

/** Ticks or un-ticks a row. `completed_at` is the user's record; sync never touches it. */
export async function toggleCompleted(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const id = occurrenceIdSchema.safeParse(formData.get("occurrenceId"));
  if (!id.success) return formError(NOT_FOUND);

  const supabase = await createClient();
  await requireUserId(supabase);

  const current = await supabase
    .from("calendar_occurrences")
    .select("completed_at")
    .eq("id", id.data)
    .maybeSingle();
  if (current.error) return formError(SAVE_FAILED);
  if (!current.data) return formError(NOT_FOUND);

  const next = current.data.completed_at === null ? new Date().toISOString() : null;
  const { error } = await supabase
    .from("calendar_occurrences")
    .update({ completed_at: next })
    .eq("id", id.data);
  if (error) return formError(SAVE_FAILED);

  revalidatePath("/calendar");
  revalidatePath("/");
  return { status: "success", message: next === null ? "Marked as not done." : "Done." };
}

/**
 * Sets or clears `weight_override` (§5.2 step 1).
 *
 * Locks the column on the way in so a later sync cannot re-derive it, and
 * **unlocks it on clear** — otherwise "reset this to the syllabus value" would
 * leave a lock behind that pins it to the derived value forever, which is the
 * opposite of what clearing means.
 */
export async function setWeightOverride(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = weightOverrideSchema.safeParse({
    itemId: formData.get("itemId"),
    weightPercent: formData.get("weightPercent"),
  });
  if (!parsed.success) return toFormState(parsed.error);

  const supabase = await createClient();
  await requireUserId(supabase);

  const item = await supabase
    .from("calendar_items")
    .select("user_locked_fields")
    .eq("id", parsed.data.itemId)
    .maybeSingle();
  if (item.error) return formError(SAVE_FAILED);
  if (!item.data) return formError(NOT_FOUND);

  const locks =
    parsed.data.weightPercent === null
      ? item.data.user_locked_fields.filter((field) => field !== "weight_override")
      : withLockedField(item.data.user_locked_fields, "weight_override");

  const { error } = await supabase
    .from("calendar_items")
    .update({ weight_override: parsed.data.weightPercent, user_locked_fields: locks })
    .eq("id", parsed.data.itemId);
  if (error) return formError(SAVE_FAILED);

  revalidatePath("/calendar");
  revalidatePath("/");
  return {
    status: "success",
    message:
      parsed.data.weightPercent === null
        ? "Weight reset to the derived value."
        : `Weight set to ${parsed.data.weightPercent}%.`,
  };
}

/* -------------------------------------------------------------------------- */
/* §5.1b — the mandatory human confirm on an exam date                        */
/* -------------------------------------------------------------------------- */

/**
 * Records the user's ruling on a course's exam date — set, reject, or reset.
 *
 * §5.1b: an exam date is **date-critical and grade-critical** — the two gates
 * deliberately reserved by the Human-reversible-AI principle — so nothing is
 * recorded as confirmed truth without an explicit action. That gate is intact
 * here: no path in this function flips a course to confirmed except one the
 * user submitted.
 *
 * ## What changed on 2026-07-19, and why
 *
 * The previous version could only accept or reject **the one session the
 * detector proposed**, and both were terminal:
 *
 * - a rejection wrote `is_exam_candidate = false` with no marker distinguishing
 *   it from "never touched", so nothing downstream could tell that a human had
 *   ruled — the read path re-detected the same session and displayed it again;
 * - and there was no way to nominate a *different* session, so a detector that
 *   picked the wrong one had no correction path at all.
 *
 * Three intents replace it. `set` and `reject` name a session; `reset` names a
 * course, because after a rejection there is no session left to point at — and
 * that asymmetry is exactly what made rejection a one-way door.
 *
 * ## 🔒 The invariant is not this function's to improvise
 *
 * *Exactly one `is_exam_candidate` per course* is decided by `planExamDecision`,
 * a pure function tested against its own output — including from a corrupted
 * two-candidate starting state. This function loads the course's full item list,
 * applies the patches it is handed, and adds nothing of its own. The UI is not
 * trusted to maintain the invariant, and neither is this action.
 *
 * ## …and since 2026-07-19 it is not this function's to *guarantee* either
 *
 * The plan is correct; applying it as N separate non-transactional UPDATEs was
 * not. Two concurrent `set`s on one course both read a one-candidate world, both
 * plan correctly, and both apply — leaving two rows at `detection_source =
 * 'manual'`. And no concurrency is needed for the second hole: sync runs under
 * `createAdminSupabaseClient`, which never passes through this function at all.
 *
 * So the invariant now lives in the database, as a partial unique index
 * (`calendar_items_one_exam_per_course`, migration 20260718235227) — the only
 * layer every writer shares. This function's remaining job is to cooperate with
 * it: apply clears before sets, and turn a rejection into a sentence.
 */
export async function setExamDate(_previous: FormState, formData: FormData): Promise<FormState> {
  const parsed = examDecisionSchema.safeParse({
    intent: formData.get("intent"),
    ...(formData.has("itemId") ? { itemId: formData.get("itemId") } : {}),
    ...(formData.has("courseId") ? { courseId: formData.get("courseId") } : {}),
  });
  if (!parsed.success) return formError(NOT_FOUND);

  const supabase = await createClient();
  await requireUserId(supabase);

  // Resolve the course first. `set`/`reject` know only a session, and the
  // invariant is a statement about the course, so the sweep cannot even be
  // planned until the sibling rows are known.
  //
  // RLS scopes both reads; an item belonging to someone else is simply not
  // found, which is why no `user_id` filter appears.
  let courseId: string;
  if (parsed.data.intent === "reset") {
    courseId = parsed.data.courseId;
  } else {
    const item = await supabase
      .from("calendar_items")
      .select("course_id")
      .eq("id", parsed.data.itemId)
      .maybeSingle();
    if (item.error) return formError(SAVE_FAILED);
    if (!item.data) return formError(NOT_FOUND);
    if (item.data.course_id === null) {
      return formError("That entry isn’t filed under a course yet, so it can’t be an exam.");
    }
    courseId = item.data.course_id;
  }

  const items = await supabase
    .from("calendar_items")
    .select("id, is_exam_candidate, detection_source, user_locked_fields")
    .eq("course_id", courseId);
  if (items.error) return formError(SAVE_FAILED);
  if ((items.data ?? []).length === 0) return formError(NOT_FOUND);

  const patches = planExamDecision(items.data ?? [], parsed.data);

  // ⚠ ORDER IS LOAD-BEARING against `calendar_items_one_exam_per_course`:
  // every clear must land before every set, or a legitimate "move the exam"
  // gives the course two candidates for the width of one statement and is
  // rejected. See `orderExamPatches`.
  for (const patch of orderExamPatches(patches)) {
    const { id, ...columns } = patch;
    const { error } = await supabase.from("calendar_items").update(columns).eq("id", id);
    if (error) {
      // 23505 here means another writer flagged a different session of this
      // course between our read and our write — a concurrent submit, or a sync
      // that re-detected while the panel was open. The user's click is genuinely
      // lost, so say so plainly and tell them what makes it work: the page they
      // are looking at is stale, and a reload will show whose write won.
      if (error.code === UNIQUE_VIOLATION) return formError(EXAM_RACE_LOST);
      return formError(SAVE_FAILED);
    }
  }

  revalidatePath("/calendar");
  revalidatePath("/");

  return { status: "success", message: DECISION_MESSAGE[parsed.data.intent] };
}

const DECISION_MESSAGE = {
  set: "Exam date set. Sync won’t change it.",
  reject: "Not an exam. Sync won’t flag it again.",
  reset: "Back to the detected date — nothing is confirmed.",
} as const satisfies Record<"set" | "reject" | "reset", string>;

/* -------------------------------------------------------------------------- */
/* §6 — structured quick-add                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Saves a manual entry (§6 step 4).
 *
 * `source = 'manual'`, `feed_id = null`, a generated UID, one occurrence row —
 * and therefore **untouchable by sync**: `planTombstones` skips every item with
 * a null `feed_id`, so a manual entry is never tombstoned for being absent from
 * a feed snapshot it was never in.
 *
 * The local date and time are converted through `wallClockToUtcIso` against
 * `profiles.timezone`. "23:59 on the 4th" means 23:59 *in Madrid*, and storing
 * the browser's or the server's idea of that instant is how a deadline lands an
 * hour into the next day.
 */
export async function createQuickAddItem(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const values = readFormValues(formData, QUICK_ADD_FIELDS);
  const parsed = quickAddSchema.safeParse(values);
  if (!parsed.success) return toFormState(parsed.error, values);

  const supabase = await createClient();
  const userId = await requireUserId(supabase);

  const profile = await supabase.from("profiles").select("timezone").maybeSingle();
  const timezone = profile.data?.timezone ?? "Europe/Madrid";

  const [year, month, day] = parsed.data.date.split("-").map(Number);
  const [hour, minute] = (parsed.data.time ?? "00:00").split(":").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return formError(SAVE_FAILED, values);
  }

  let startsAt: string;
  try {
    startsAt = wallClockToUtcIso(
      { year, month, day, hour: hour ?? 0, minute: minute ?? 0, second: 0 },
      timezone,
    );
  } catch {
    // `profiles.timezone` holds an id the platform tz database doesn't know.
    // Failing loudly beats silently floating the time (§3.4).
    return formError("Your timezone setting isn’t one we recognise.", values);
  }

  const endsAt =
    parsed.data.durationMinutes === null
      ? null
      : new Date(Date.parse(startsAt) + parsed.data.durationMinutes * 60_000).toISOString();

  const item = await supabase
    .from("calendar_items")
    .insert({
      user_id: userId,
      feed_id: null,
      source: "manual",
      ics_uid: crypto.randomUUID(),
      kind: parsed.data.kind,
      title: parsed.data.title,
      course_id: parsed.data.courseId,
      weight_override: parsed.data.weightPercent,
    })
    .select("id")
    .maybeSingle();

  if (item.error || !item.data) return formError(SAVE_FAILED, values);

  const occurrence = await supabase.from("calendar_occurrences").insert({
    user_id: userId,
    item_id: item.data.id,
    // Non-recurring, so the sole instance takes the empty-string recurrence id
    // the schema defaults to — a null here would make every sole instance
    // distinct from every other and defeat the upsert identity.
    recurrence_id: "",
    starts_at: startsAt,
    ends_at: endsAt,
    all_day: parsed.data.time === null,
  });

  if (occurrence.error) {
    // The item without its occurrence is invisible to every view — it would be
    // a row the user cannot see, edit or delete. Roll it back.
    await supabase.from("calendar_items").delete().eq("id", item.data.id);
    return formError(SAVE_FAILED, values);
  }

  revalidatePath("/calendar");
  revalidatePath("/");
  return { status: "success", message: `${parsed.data.title} added.`, values: CLEARED };
}
