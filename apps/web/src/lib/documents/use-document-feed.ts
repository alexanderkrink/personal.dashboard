"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { createClient } from "@/lib/supabase/client";

/**
 * Live document status, via Supabase Realtime (PLAN §8: *"UI subscribes via
 * Supabase Realtime (`postgres_changes` on both tables filtered by `course_id`)
 * — no polling"*).
 *
 * ## 🔴 Realtime is an ACCELERATOR here, not the source of truth
 *
 * This is the single most important thing about this module, and it is the
 * opposite of how the feature reads on paper.
 *
 * Wave 4's gate 1 measured that `pg_replication_slots` on this project is
 * **empty**: Supabase Realtime creates its WAL slot *lazily*, on the first
 * subscriber, and tears it down again when the last one leaves. The channel join
 * and the slot are independent — the websocket answers `SUBSCRIBED` as soon as
 * the *channel* is joined, which happens whether or not the replication slot
 * behind it has finished coming up.
 *
 * So there is a window, right after the first subscription following any idle
 * period, in which the client believes it is listening and **changes are
 * silently dropped**. Nothing errors. Nothing retries. The status card simply
 * sits at `queued` forever while the database says `ready`.
 *
 * That window is exactly when our pipeline runs. `validate → finalize` completes
 * in about a second, and the user subscribes at the moment they upload — i.e.
 * the subscription and the entire run overlap the warm-up.
 *
 * The fix is to stop treating the subscription as the mechanism:
 *
 *   1. **Subscribe first**, so nothing that happens after this point is missed.
 *   2. **On `SUBSCRIBED`, backfill current state over REST.** This is the
 *      authoritative read. `documents_course_status_idx` and
 *      `document_processing_events_course_feed_idx` exist to serve exactly it.
 *   3. **Treat every subsequent event as an accelerator** over that baseline —
 *      nice to have, never depended upon.
 *
 * ## The reconciliation watchdog, and why it is not "polling"
 *
 * Steps 1–3 still leave a gap: if the slot finishes coming up *after* the
 * backfill query ran, changes in between belong to neither. It is a small window
 * and it is a real one, and a status UI that can permanently show the wrong
 * terminal state is worse than one that occasionally re-reads.
 *
 * So while any document is **non-terminal**, this re-backfills every few
 * seconds. The distinction from polling is not pedantry:
 *
 *   - it stops completely once every document is `ready` / `partial` / `failed`,
 *     so the steady state is **zero requests** — an idle documents page makes no
 *     network traffic at all;
 *   - it never drives the UI on its own. Realtime events still deliver in
 *     milliseconds and this only fires if one went missing.
 *
 * PLAN's "no polling" is a rejection of *poll-as-transport* — a fixed interval
 * carrying every update, running forever. This is a bounded safety net over a
 * transport with a known, measured warm-up hole.
 */

/**
 * A Realtime payload is an external boundary like any other: it arrives as JSON
 * over a websocket, and `postgres_changes` types it as `Record<string, unknown>`
 * because the server cannot know our schema. Casting would make a malformed
 * payload into a card that renders `undefined`; parsing turns it into a payload
 * we ignore, and the next backfill supplies the truth.
 *
 * The fields are deliberately loose (`status` is a string, not the enum) —
 * this schema's job is to establish shape, not to duplicate the database's
 * constraints, which are already enforced where it counts.
 */
const documentRowSchema = z.object({
  id: z.uuid(),
  course_id: z.uuid(),
  filename: z.string(),
  kind: z.string(),
  status: z.string(),
  mime_type: z.string(),
  size_bytes: z.number(),
  failure_reason: z.string().nullable(),
  deep_review: z.string(),
  extraction_fidelity: z.string().nullable(),
  created_at: z.string(),
  processed_at: z.string().nullable(),
});

const processingEventRowSchema = z.object({
  id: z.number(),
  document_id: z.uuid(),
  step: z.string(),
  level: z.string(),
  detail: z.string().nullable(),
  created_at: z.string(),
});

export type DocumentRow = z.infer<typeof documentRowSchema>;
export type ProcessingEventRow = z.infer<typeof processingEventRowSchema>;

const DOCUMENT_COLUMNS =
  "id, course_id, filename, kind, status, mime_type, size_bytes, failure_reason, deep_review, extraction_fidelity, created_at, processed_at";

const TERMINAL_STATUSES = new Set(["ready", "partial", "failed"]);

/** How many feed lines to keep per course. The card shows the last few per document. */
const FEED_LIMIT = 200;

/** Reconciliation cadence while work is in flight. Stops entirely when it isn't. */
const WATCHDOG_MS = 4000;

export interface DocumentFeed {
  readonly documents: readonly DocumentRow[];
  readonly events: readonly ProcessingEventRow[];
  /** True once the first backfill has landed — before that the list is the server's. */
  readonly ready: boolean;
  /** Forces a re-read. The upload dialog calls it the moment a row is registered. */
  readonly refresh: () => void;
}

export function useDocumentFeed(
  courseId: string | null,
  initialDocuments: readonly DocumentRow[],
): DocumentFeed {
  const [documents, setDocuments] = useState<readonly DocumentRow[]>(initialDocuments);
  const [events, setEvents] = useState<readonly ProcessingEventRow[]>([]);
  const [ready, setReady] = useState(false);

  // The backfill closure changes identity on every render; the watchdog and the
  // subscription both need the *current* one without being torn down and rebuilt
  // each time, which would itself restart the warm-up race this exists to solve.
  const backfillRef = useRef<() => Promise<void>>(async () => {});

  const backfill = useCallback(async () => {
    if (courseId === null) return;
    const supabase = createClient();

    // Both reads are RLS-scoped: the browser client carries the user's session,
    // so "this course" can only ever mean a course they own.
    const [documentsResult, eventsResult] = await Promise.all([
      supabase
        .from("documents")
        .select(DOCUMENT_COLUMNS)
        .eq("course_id", courseId)
        .order("created_at", { ascending: false }),
      supabase
        .from("document_processing_events")
        .select("id, document_id, step, level, detail, created_at")
        .eq("course_id", courseId)
        .order("id", { ascending: false })
        .limit(FEED_LIMIT),
    ]);

    const parsedDocuments = z.array(documentRowSchema).safeParse(documentsResult.data ?? []);
    if (parsedDocuments.success) setDocuments(parsedDocuments.data);

    const parsedEvents = z.array(processingEventRowSchema).safeParse(eventsResult.data ?? []);
    // Queried newest-first (the index is descending); the UI reads oldest-first,
    // so it is reversed once here rather than at every render.
    if (parsedEvents.success) setEvents([...parsedEvents.data].reverse());

    setReady(true);
  }, [courseId]);

  backfillRef.current = backfill;

  useEffect(() => {
    if (courseId === null) return;
    const supabase = createClient();
    // `cancelled` guards the async gap below: the effect can be torn down while
    // `setAuth` is still in flight, and subscribing after that would leak a
    // channel the cleanup has already run past.
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    /**
     * ⚠ THE REALTIME SOCKET MUST BE HANDED THE USER'S JWT BEFORE SUBSCRIBING.
     *
     * This is not defensive coding — without it the feature is silently, totally
     * dead, and it was: measured in a browser, three uploads in a row reached
     * `ready` in the database and **not one `postgres_changes` frame arrived**.
     * The step checklist only ever advanced because the watchdog backfill below
     * happened to notice.
     *
     * The cause is that the websocket connects with the **publishable (anon)
     * key**, not the session. Realtime evaluates each table's RLS policies
     * against the subscriber's token before forwarding a row, and every policy
     * on `documents` and `document_processing_events` is
     * `(select auth.uid()) = user_id`. With an anon token `auth.uid()` is NULL,
     * that comparison is NULL, and **every row is withheld**.
     *
     * The failure mode is the reason this comment is this long: nothing errors.
     * The channel reports `SUBSCRIBED`, the socket stays open, the server is
     * happy — it has correctly decided this subscriber may see nothing. An
     * authorization failure and an idle system look identical from here, which
     * is exactly how this ships broken.
     *
     * `setAuth` is also why the subscribe is inside an async function: the token
     * has to be on the socket *before* the join, or the join is evaluated
     * against the anon one.
     */
    void (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (cancelled) return;

      await supabase.realtime.setAuth(session?.access_token ?? null);
      if (cancelled) return;

      channel = supabase
        .channel(`documents:${courseId}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "documents",
            filter: `course_id=eq.${courseId}`,
          },
          (payload) => {
            setDocuments((current) => applyDocumentChange(current, payload));
          },
        )
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "document_processing_events",
            filter: `course_id=eq.${courseId}`,
          },
          (payload) => {
            const parsed = processingEventRowSchema.safeParse(payload.new);
            if (!parsed.success) return;
            const row = parsed.data;
            setEvents((current) =>
              // Deduplicated by id: the backfill and the live stream overlap by
              // design, so the same line arrives twice in the ordinary case.
              current.some((event) => event.id === row.id) ? current : [...current, row],
            );
          },
        )
        .subscribe((status) => {
          // ⚠ The backfill hangs off SUBSCRIBED, not off mount. Reading before
          // the channel is joined would reopen the gap from the other side:
          // changes between the read and the join would be missed by both.
          if (status === "SUBSCRIBED") void backfillRef.current();
        });
    })();

    return () => {
      cancelled = true;
      if (channel !== null) void supabase.removeChannel(channel);
    };
  }, [courseId]);

  // The watchdog. Note the dependency on `documents`: it re-evaluates whenever
  // the set changes, so it starts when a document goes non-terminal and clears
  // itself the moment the last one finishes.
  const hasWorkInFlight = documents.some((document) => !TERMINAL_STATUSES.has(document.status));

  useEffect(() => {
    if (!hasWorkInFlight || courseId === null) return;
    const timer = setInterval(() => void backfillRef.current(), WATCHDOG_MS);
    return () => clearInterval(timer);
  }, [hasWorkInFlight, courseId]);

  const refresh = useCallback(() => {
    void backfillRef.current();
  }, []);

  return { documents, events, ready, refresh };
}

/**
 * Folds one `postgres_changes` payload into the document list.
 *
 * DELETE carries only the old row, and thanks to `replica identity full`
 * (20260719175554) that old row is complete rather than just a primary key —
 * which is what makes the `course_id` filter match on deletes at all.
 */
function applyDocumentChange(
  current: readonly DocumentRow[],
  payload: { eventType: string; new: Record<string, unknown>; old: Record<string, unknown> },
): readonly DocumentRow[] {
  if (payload.eventType === "DELETE") {
    const removedId = z.uuid().safeParse(payload.old.id);
    return removedId.success
      ? current.filter((document) => document.id !== removedId.data)
      : current;
  }

  const parsed = documentRowSchema.safeParse(payload.new);
  // An unparseable payload is dropped rather than guessed at. The watchdog
  // backfill is still running while this document is non-terminal, so the state
  // it carried is not lost — it just arrives a beat later, from the database.
  if (!parsed.success) return current;
  const row = parsed.data;

  const index = current.findIndex((document) => document.id === row.id);
  if (index === -1) return [row, ...current];

  const next = [...current];
  next[index] = row;
  return next;
}
