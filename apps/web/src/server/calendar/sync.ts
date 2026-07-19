/**
 * The sync engine (§3).
 *
 * Provider-agnostic by construction: it asks `PROVIDERS[feed.provider]` for
 * normalized events and owns everything stateful itself — dedup, the row diff,
 * course matching, tombstones, cancellations, and the field locks that keep a
 * user's edits from being overwritten.
 *
 * Runs under `createAdminSupabaseClient`, which bypasses RLS. Every row it
 * writes therefore carries `user_id` explicitly, taken from the feed row it
 * claimed — never from a parameter a caller could choose — and the composite
 * `(id, user_id)` foreign keys reject the result if it is ever wrong. That is
 * the safety net; this file's job is not to need it.
 */

import {
  detectExam,
  type ExamCandidateEvent,
  type NormalizedEvent,
  normalizeSummary,
} from "@study/core";
import type { Json } from "@study/db";
import { redactSecrets } from "@/lib/calendar/secret";
import { createCourseMatcher } from "./course-match";
import {
  applyLocks,
  changedFields,
  type OccurrencePayload,
  occurrenceFingerprint,
  planOrphanedOccurrences,
  planTombstones,
  preserveCourseLink,
  toOccurrencePayload,
  toSyncedItemPayload,
} from "./diff";
import { calendarHorizon } from "./horizon";
import { providerFor } from "./providers";
import type { CalendarStore, OccurrenceUpsert, StoredItem, SyncContext } from "./store";

/** How long a claimed feed stays claimed if the run dies without releasing it. */
const LEASE_SECONDS = 300;

export type SyncOutcome =
  /** Another run holds the lease. Not an error — the specified behaviour. */
  | { status: "skipped"; reason: "locked" }
  /** Nothing changed upstream; no parse, no writes. */
  | { status: "unchanged" }
  | {
      status: "ok";
      /** Rows actually inserted or patched. */
      itemsWritten: number;
      /** Rows whose every synced column already matched, so nothing was written. */
      itemsUnchanged: number;
      occurrencesWritten: number;
      /** Occurrences whose payload was byte-identical, so nothing was written. */
      occurrencesUnchanged: number;
      tombstoned: number;
      resurrected: number;
      /**
       * Vanished from the feed, already in the past, kept permanently (§3.3).
       *
       * Reported separately from `tombstoned` because the two are opposites: one
       * counts rows now on a deletion timer, the other counts rows that can never
       * be on one. Collapsing them would hide the entire distinction this field
       * exists to make visible.
       */
      retained: number;
      deleted: number;
      cancelled: number;
    }
  | { status: "error"; message: string };

/**
 * Syncs one feed, start to finish.
 *
 * `now` is injected so the whole lifecycle — the 24-hour hide, the 7-day delete
 * — can be exercised in a test without waiting a week or writing to the clock.
 */
export async function syncFeed(
  store: CalendarStore,
  feedId: string,
  now: Date = new Date(),
): Promise<SyncOutcome> {
  const feed = await store.claimFeed(feedId, LEASE_SECONDS);
  if (!feed) return { status: "skipped", reason: "locked" };

  const nowIso = now.toISOString();
  // Captured up front: whatever happens below, the lease has to be released and
  // an outcome recorded, and the failure paths are exactly the ones that would
  // otherwise leave a feed locked for five minutes.
  try {
    return await runSync(store, feed, nowIso, now);
  } catch (cause) {
    const message = redactSecrets(
      cause instanceof Error ? cause.message : String(cause),
      collectSecrets(feed.config),
    );
    await store.finishFeed(feedId, {
      status: "error",
      error: message,
      cursor: feed.sync_cursor,
      syncedAt: nowIso,
    });
    return { status: "error", message };
  }
}

async function runSync(
  store: CalendarStore,
  feed: Awaited<ReturnType<CalendarStore["claimFeed"]>> & object,
  nowIso: string,
  now: Date,
): Promise<SyncOutcome> {
  const secrets = collectSecrets(feed.config);
  const provider = providerFor(feed.provider);
  if (!provider) {
    const message = `Unknown calendar provider “${feed.provider}”.`;
    await store.finishFeed(feed.id, {
      status: "error",
      error: message,
      cursor: feed.sync_cursor,
      syncedAt: nowIso,
    });
    return { status: "error", message };
  }

  const context = await store.loadContext(feed.user_id);

  const result = await provider.sync({
    // Course titles ride along on the config object for kind rule 1b. The
    // provider's schema ignores unknown keys; `SyncInput` has no field for them
    // because core must not know this application has a `courses` table.
    config: {
      ...(typeof feed.config === "object" && feed.config !== null ? feed.config : {}),
      knownCourseNames: context.courses.map((course) => course.title),
    },
    cursor: feed.sync_cursor,
    horizon: calendarHorizon(now),
    defaultTimezone: context.timezone,
  });

  if (!result.ok) {
    const message = describeSyncError(result.error, secrets);
    await store.finishFeed(feed.id, {
      status: "error",
      error: message,
      cursor: feed.sync_cursor,
      syncedAt: nowIso,
    });
    return { status: "error", message };
  }

  // §3.2 layers 1 and 2 both land here: a 304, or a byte-identical body.
  if (!result.value.changed) {
    await store.finishFeed(feed.id, {
      status: "unchanged",
      error: null,
      cursor: result.value.cursor as Json,
      syncedAt: nowIso,
    });
    return { status: "unchanged" };
  }

  const events = result.value.events;
  const matchCourse = courseMatcher(context, feed.config);

  /* ---- items ---------------------------------------------------------- */

  const allUserItems = await store.listUserItems(feed.user_id);
  // Scoped to THIS feed. Without this, syncing feed A would tombstone every
  // item belonging to feed B, since none of B's UIDs are in A's snapshot.
  const feedItems = allUserItems.filter((item) => item.feed_id === feed.id);
  const byUid = new Map(feedItems.map((item) => [item.ics_uid, item]));

  let itemsWritten = 0;
  let itemsUnchanged = 0;
  const itemIdByUid = new Map<string, string>();
  const toInsert: Parameters<CalendarStore["upsertItems"]>[0][number][] = [];

  for (const event of events) {
    const existing = byUid.get(event.uid);
    const payload = toSyncedItemPayload(event, matchCourse(event.courseHint ?? event.title));

    // §3.3: never clobber a field the user edited.
    //
    // INSERT and UPDATE are deliberately different operations here, and
    // collapsing them into one upsert is what makes locking quietly fail. An
    // upsert has to supply a value for every `not null` column, so a locked
    // `title` forces some fallback — and the only fallback available on the
    // insert path is the feed's own value, which is precisely the value the
    // lock exists to keep out. A test caught exactly that.
    //
    // Split, both halves are trivially right:
    //   - existing row -> PATCH with the unlocked columns that ACTUALLY differ.
    //     A locked column is absent from the statement, so nothing can
    //     overwrite it; an unchanged column is absent too, so `updated_at`
    //     keeps meaning "this row changed".
    //   - new row -> INSERT. There is no lock to honour, because there is no
    //     user edit yet to protect.
    if (existing) {
      itemIdByUid.set(event.uid, existing.id);
      // Matching is additive: "no match" never strips a course this row already
      // has. Applied before the locks so the guard covers unlocked rows too —
      // which is every row the user has not personally filed, i.e. all the ones
      // archiving a course would otherwise have orphaned.
      const allowed = applyLocks(
        preserveCourseLink(payload, existing),
        existing.user_locked_fields,
      );
      const patch: Record<string, unknown> = {
        ...changedFields(allowed, existing as unknown as Record<string, unknown>),
      };
      // Reappearance clears the tombstone: the item came back, so it is not
      // missing any more, and it keeps its id, its course and its occurrences.
      if (existing.missing_since !== null) patch.missing_since = null;

      if (Object.keys(patch).length > 0) {
        await store.patchItem(existing.id, patch);
        itemsWritten += 1;
      } else {
        itemsUnchanged += 1;
      }
    } else {
      toInsert.push({
        user_id: feed.user_id,
        feed_id: feed.id,
        ics_uid: event.uid,
        source: "ics",
        ...payload,
      });
    }
  }

  if (toInsert.length > 0) {
    const inserted = await store.upsertItems(toInsert);
    for (const [uid, id] of inserted) itemIdByUid.set(uid, id);
    itemsWritten += toInsert.length;
  }

  /* ---- occurrences (§3.2 layer 3) ------------------------------------- */

  // Deliberately a SUPERSET of the items present in this snapshot: every item of
  // this feed, including the ones that just vanished from it. The vanished ones
  // are precisely the tombstone candidates, and §3.3 now needs each candidate's
  // last occurrence date to tell a cancellation from a feed-window roll-off — so
  // the rows it needs are exactly the rows the old, snapshot-scoped query left
  // out. One query either way; the extra rows are ignored by both consumers
  // below, which key on `item_id`.
  const itemIds = [...new Set([...itemIdByUid.values(), ...feedItems.map((item) => item.id)])];
  const storedOccurrences = await store.listOccurrences(itemIds);

  // Latest, not earliest — an item is only safely "past" once its LAST occurrence
  // is past. See `TombstoneCandidate.latestOccurrenceStartsAt`.
  const latestOccurrenceByItem = new Map<string, string>();
  for (const occurrence of storedOccurrences) {
    const current = latestOccurrenceByItem.get(occurrence.item_id);
    // Compared as instants, not strings: PostgREST spells a timestamptz
    // `…T08:00:00+00:00` and the parser spells it `…T08:00:00.000Z`, so a
    // lexicographic max over mixed spellings picks the wrong row. Same trap that
    // made the row diff rewrite all 374 occurrences every sync.
    if (current === undefined || Date.parse(occurrence.starts_at) > Date.parse(current)) {
      latestOccurrenceByItem.set(occurrence.item_id, occurrence.starts_at);
    }
  }
  const storedByKey = new Map(
    storedOccurrences.map((occurrence) => [
      `${occurrence.item_id}\u0000${occurrence.recurrence_id}`,
      occurrence,
    ]),
  );

  const toWrite: OccurrenceUpsert[] = [];
  let occurrencesUnchanged = 0;

  for (const event of events) {
    const itemId = itemIdByUid.get(event.uid);
    if (!itemId) continue;

    for (const occurrence of event.occurrences) {
      const payload = toOccurrencePayload(occurrence);
      const stored = storedByKey.get(`${itemId}\u0000${occurrence.recurrenceId}`);

      // The point of the row diff: an unchanged payload is not written, so
      // `updated_at` keeps meaning "this row changed" rather than "a sync ran".
      // That matters beyond tidiness — §3.6 dates the strike-through on a
      // cancelled occurrence from exactly this timestamp.
      if (
        stored &&
        occurrenceFingerprint({
          starts_at: stored.starts_at,
          ends_at: stored.ends_at,
          all_day: stored.all_day,
          // `calendar_occurrences.status` is `text` with a check constraint, so
          // it arrives typed as `string`. The constraint is what guarantees it
          // is one of the three, which the type system cannot see.
          status: stored.status as OccurrencePayload["status"],
          overridden: stored.overridden,
        }) === occurrenceFingerprint(payload)
      ) {
        occurrencesUnchanged += 1;
        continue;
      }

      toWrite.push({
        user_id: feed.user_id,
        item_id: itemId,
        recurrence_id: occurrence.recurrenceId,
        ...payload,
      });
    }
  }

  if (toWrite.length > 0) await store.upsertOccurrences(toWrite);

  // §3.6 form 2: an instance the feed stopped expanding (an EXDATE added
  // upstream). Cancelled, never deleted — "this lecture is not happening" is
  // information, and a silent gap in the week does not convey it.
  const orphanIds: string[] = [];
  for (const event of events) {
    const itemId = itemIdByUid.get(event.uid);
    if (!itemId) continue;
    orphanIds.push(
      ...planOrphanedOccurrences(
        storedOccurrences.filter((occurrence) => occurrence.item_id === itemId),
        event.occurrences,
      ),
    );
  }
  if (orphanIds.length > 0) await store.cancelOccurrences(orphanIds);

  /* ---- tombstones (§3.3) ---------------------------------------------- */

  const presentUids = new Set(events.map((event) => event.uid));
  const actions = planTombstones(
    feedItems.map((item) => ({
      ...item,
      latestOccurrenceStartsAt: latestOccurrenceByItem.get(item.id) ?? null,
    })),
    presentUids,
    nowIso,
  );

  let tombstoned = 0;
  let resurrected = 0;
  let retained = 0;
  const toDelete: string[] = [];

  for (const action of actions) {
    if (action.action === "mark") {
      await store.patchItem(action.id, { missing_since: action.missingSince });
      tombstoned += 1;
    } else if (action.action === "clear") {
      await store.patchItem(action.id, { missing_since: null });
      resurrected += 1;
    } else if (action.action === "delete") {
      toDelete.push(action.id);
    } else if (action.action === "retain") {
      // Gone from the feed, but in the past — a window roll-off, not a
      // cancellation. Nothing is scheduled for deletion. The only write is
      // undoing a mark the OLD rule made, which is how the 5 rows already
      // tombstoned on the live database heal themselves on the next sync.
      if (action.clearMissingSince) await store.patchItem(action.id, { missing_since: null });
      retained += 1;
    }
    // "keep" is genuinely nothing: the row stays exactly as it is, ORIGINAL
    // missing_since intact, so the 7-day clock keeps running instead of being
    // reset by every sync.
  }
  if (toDelete.length > 0) await store.deleteItems(toDelete);

  /* ---- §5.1b exam candidacy ------------------------------------------- */

  const cancelled = orphanIds.length;
  await markExamCandidates(store, context, events, itemIdByUid, allUserItems, feed.config);

  await store.finishFeed(feed.id, {
    status: "ok",
    error: null,
    cursor: result.value.cursor as Json,
    syncedAt: nowIso,
  });

  return {
    status: "ok",
    itemsWritten,
    itemsUnchanged,
    occurrencesWritten: toWrite.length,
    occurrencesUnchanged,
    tombstoned,
    resurrected,
    retained,
    deleted: toDelete.length,
    cancelled,
  };
}

/* -------------------------------------------------------------------------- */
/* Course matching (§5.1)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The §5.1 chain for one sync run, reduced to the id the row needs.
 *
 * The chain itself lives in `course-match.ts` because the **read** path runs the
 * identical logic — the Unassigned bucket groups by the hint that failed to
 * match, and a second implementation there would show a bucket whose contents
 * disagree with what the next sync does.
 *
 * `config.courseId` is read here rather than inside the matcher so the feed row
 * stays the only thing that knows about feed configuration.
 */
function courseMatcher(context: SyncContext, config: unknown): (hint: string) => string | null {
  const pinnedCourseId =
    typeof config === "object" && config !== null && "courseId" in config
      ? ((config as { courseId?: unknown }).courseId ?? null)
      : null;

  const match = createCourseMatcher({
    pinnedCourseId: typeof pinnedCourseId === "string" ? pinnedCourseId : null,
    matchers: context.matchers,
    courses: context.courses,
  });

  return (hint: string) => match(hint)?.courseId ?? null;
}

/* -------------------------------------------------------------------------- */
/* §5.1b exam candidacy                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What `calendar_items` gives a freshly inserted row for the three columns
 * exam detection writes. Mirrors the `default` clauses in
 * `20260718174222_calendar_tables.sql`.
 */
const INSERTED_ITEM_DEFAULTS = {
  is_exam_candidate: false,
  hidden: false,
  detection_source: null,
} as const;

/**
 * Runs core's `detectExam()` once per matched course and records the answer.
 *
 * Also hides retakes, which §5.1b requires be hidden by default and **never**
 * deleted — a re-sit you did not know about is worse than a cluttered calendar.
 *
 * Every write here goes through the lock check, because "this is the exam" and
 * "this is hidden" are both things a user is entitled to disagree with.
 */
async function markExamCandidates(
  store: CalendarStore,
  context: SyncContext,
  events: readonly NormalizedEvent[],
  itemIdByUid: ReadonlyMap<string, string>,
  storedItems: readonly StoredItem[],
  feedConfig: unknown,
): Promise<void> {
  const locksById = new Map(storedItems.map((item) => [item.id, item.user_locked_fields]));
  const storedById = new Map(storedItems.map((item) => [item.id, item]));
  const matchCourse = courseMatcher(context, feedConfig);

  const byCourse = new Map<string, ExamCandidateEvent[]>();
  const retakeUids = new Set<string>();

  for (const event of events) {
    const summary = normalizeSummary(event.rawSummary);
    if (!summary) continue;
    if (summary.descriptor === "retake") retakeUids.add(event.uid);

    const courseId = matchCourse(event.courseHint ?? event.title);
    if (!courseId) continue;

    const first = event.occurrences[0];
    if (!first) continue;

    const bucket = byCourse.get(courseId) ?? [];
    bucket.push({ uid: event.uid, startsAtUtc: first.startsAtUtc, summary });
    byCourse.set(courseId, bucket);
  }

  const semesters = context.semesters.map((semester) => ({
    startsAt: semester.starts_on,
    endsAt: semester.ends_on,
  }));

  const examUids = new Map<string, string>();

  for (const [courseId, candidates] of byCourse) {
    const course = context.courses.find((entry) => entry.id === courseId);
    const detection = detectExam({
      events: candidates,
      totalSessions: course?.total_sessions ?? null,
      assessments: context.assessments
        .filter((assessment) => assessment.course_id === courseId)
        .map((assessment) => ({
          id: assessment.id,
          title: assessment.title,
          kind: assessment.kind,
          sessionNumber: assessment.session_number,
        })),
      semesters,
    });

    if (detection.outcome === "found") examUids.set(detection.uid, detection.source);
  }

  // 🔒 Courses the user has already ruled on.
  //
  // The lock lives on the row the user touched, but the DECISION is about the
  // course: "this session is the exam" and "this course has no exam" both mean
  // *stop proposing for this course*, which is exactly what the buttons promise
  // ("Sync won't change it" / "Sync won't flag it again") and exactly what
  // `reset` undoes by dropping the lock.
  //
  // Checking the lock per ITEM instead — as this loop used to — honoured the
  // decision on the row it was written to and ignored it everywhere else, so a
  // detector that picked a DIFFERENT session of the same course happily flagged
  // that one too. Two consequences, both bad and both real:
  //
  //   * it produced the second candidate the read path cannot cope with, and
  //     since 20260718235227 that write is rejected outright by
  //     `calendar_items_one_exam_per_course` — failing the WHOLE feed sync over
  //     one course's disagreement. Observed on the live feed, not theorised.
  //   * after a rejection it would re-propose a different session of a course
  //     the user had just said has no exam at all.
  const decidedCourses = new Set(
    storedItems
      .filter((item) => item.user_locked_fields.includes("is_exam_candidate"))
      .map((item) => item.course_id)
      .filter((courseId): courseId is string => courseId !== null),
  );

  const writes: { itemId: string; changed: Record<string, unknown> }[] = [];

  for (const [uid, itemId] of itemIdByUid) {
    const stored = storedById.get(itemId);
    const locks = locksById.get(itemId) ?? [];
    const patch: Record<string, unknown> = {};

    const courseId = stored?.course_id ?? null;
    const userDecided =
      locks.includes("is_exam_candidate") || (courseId !== null && decidedCourses.has(courseId));

    const source = examUids.get(uid);
    if (!userDecided) {
      patch.is_exam_candidate = source !== undefined;
      patch.detection_source = source ?? null;
    }
    if (!locks.includes("hidden")) {
      patch.hidden = retakeUids.has(uid);
    }

    // Same discipline as the item loop: write only what differs.
    //
    // A row inserted moments ago is not in `storedItems`, but its values are
    // not unknown — they are the column defaults, which are exactly the three
    // below. Comparing against those instead of skipping the diff is what stops
    // a first sync issuing one UPDATE per event to restate what it just
    // inserted: 374 round trips on the real feed, all of them no-ops.
    const current = (stored ?? INSERTED_ITEM_DEFAULTS) as unknown as Record<string, unknown>;
    const changed = changedFields(patch, current);
    if (Object.keys(changed).length > 0) writes.push({ itemId, changed });
  }

  // ⚠ Clears before sets, for the same reason `orderExamPatches` exists on the
  // user path: when the detector's answer MOVES to a different session, this
  // loop emits both a clear and a set for one course, and the partial unique
  // index — which cannot be deferred — rejects the set if it lands first.
  writes.sort(
    (a, b) =>
      Number(a.changed.is_exam_candidate === true) - Number(b.changed.is_exam_candidate === true),
  );

  for (const write of writes) await store.patchItem(write.itemId, write.changed);
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Turns a `SyncError` into a sentence for `last_sync_error`.
 *
 * Every branch produces text written HERE, never text handed up from a network
 * layer — the one place a token could realistically leak into a column the
 * client reads back. The parse branch is the only one carrying remote content,
 * and it is redacted.
 */
function describeSyncError(
  error: { kind: string; detail?: string },
  secrets: readonly string[],
): string {
  switch (error.kind) {
    case "unauthorized":
      return "The feed rejected our request. The subscription link has probably been reset — reconnect the feed with a fresh URL.";
    case "unavailable":
      return "Couldn’t reach the feed. It may be temporarily down; the next sync will try again.";
    case "parse":
      return redactSecrets(
        `The feed downloaded but couldn’t be read: ${error.detail ?? "unknown parse failure"}`,
        secrets,
      );
    default:
      return "The sync failed for an unknown reason.";
  }
}

/**
 * Every string in a feed config, so redaction has the actual secret to look for
 * rather than only its shape. Config is `jsonb`, so this walks it generically
 * instead of assuming `{ url }` — a future provider's secret in another key is
 * still a secret.
 */
function collectSecrets(config: unknown): string[] {
  if (typeof config === "string") return [config];
  if (Array.isArray(config)) return config.flatMap(collectSecrets);
  if (typeof config === "object" && config !== null) {
    return Object.values(config).flatMap(collectSecrets);
  }
  return [];
}
