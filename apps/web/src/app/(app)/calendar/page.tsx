import { CalendarBlank } from "@phosphor-icons/react/dist/ssr";
import type { Metadata } from "next";
import { createFeed, updateFeed } from "@/app/(app)/calendar/actions";
import { FeedCreateForm } from "@/components/calendar/feed-form";
import { FeedRow, type FeedView } from "@/components/calendar/feed-row";
import { CourseDot } from "@/components/courses/course-dot";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { feedFingerprint, maskFeedUrl } from "@/lib/calendar/secret";
import { createClient } from "@/lib/supabase/server";
import { isCancelledOccurrenceVisible, isTombstoneVisible } from "@/server/calendar/diff";

export const metadata: Metadata = { title: "Calendar" };

/** How far ahead the plain list looks. The ranked week view (§7) arrives later. */
const LIST_DAYS_AHEAD = 21;

function formatDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone,
  }).format(new Date(iso));
}

function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(new Date(iso));
}

/**
 * The calendar hub: feed management plus a plain chronological list.
 *
 * The list is deliberately the simplest thing that is true — one row per
 * occurrence, in time order. PLAN §7's ranked "This week" view and the week
 * grid are a later item, and shipping something that merely *looked* like them
 * would make it impossible to tell whether the sync underneath actually works,
 * which is the one thing this page is currently evidence for.
 *
 * 🔒 The feed URL never reaches this component's output. `FeedView` has no
 * `url` field; what crosses to the client is the masked origin and a
 * non-reversible fingerprint.
 */
export default async function CalendarPage() {
  const supabase = await createClient();
  const nowIso = new Date().toISOString();
  const until = new Date(Date.now() + LIST_DAYS_AHEAD * 86_400_000).toISOString();

  // RLS scopes every one of these to the signed-in user; an explicit user_id
  // filter would be redundant, and its absence is not an oversight.
  const [{ data: profile }, { data: feeds }, { data: occurrences }] = await Promise.all([
    supabase.from("profiles").select("timezone").maybeSingle(),
    supabase
      .from("calendar_feeds")
      .select(
        "id, label, config, active, last_synced_at, last_sync_status, last_sync_error, calendar_items (id)",
      )
      .order("created_at", { ascending: true }),
    supabase
      .from("calendar_occurrences")
      .select(
        "id, starts_at, all_day, status, updated_at, calendar_items!inner (title, hidden, missing_since, courses (title, color))",
      )
      .gte("starts_at", nowIso)
      .lte("starts_at", until)
      .order("starts_at", { ascending: true })
      .limit(200),
  ]);

  const timeZone = profile?.timezone ?? "Europe/Madrid";

  const feedViews: FeedView[] = (feeds ?? []).map((feed) => {
    const url =
      typeof feed.config === "object" && feed.config !== null && "url" in feed.config
        ? String((feed.config as { url: unknown }).url)
        : "";
    return {
      id: feed.id,
      label: feed.label,
      maskedUrl: maskFeedUrl(url),
      fingerprint: feedFingerprint(url),
      active: feed.active,
      lastSyncedAt: feed.last_synced_at,
      lastSyncStatus: feed.last_sync_status,
      lastSyncError: feed.last_sync_error,
      itemCount: feed.calendar_items.length,
    };
  });

  // Read-time filtering, so the grace periods can be tuned without a migration
  // and without discarding anything already tombstoned (§3.3, §3.6).
  const visible = (occurrences ?? []).filter((occurrence) => {
    const item = occurrence.calendar_items;
    if (item.hidden) return false;
    if (!isTombstoneVisible(item.missing_since, nowIso)) return false;
    if (occurrence.status === "cancelled") {
      return isCancelledOccurrenceVisible(occurrence.updated_at, nowIso);
    }
    return true;
  });

  return (
    <>
      <PageHeader
        title="Calendar"
        lead="Classes and deadlines for the weeks ahead, in one place."
      />

      {feedViews.length === 0 ? (
        <EmptyState
          icon={CalendarBlank}
          headline="No feeds connected."
          body="Your timetable lives in your university's calendar, not here. Point this at that feed once and the weeks ahead keep themselves current."
          points={[
            {
              term: "Read-only",
              detail: "nothing is ever written back to your university's calendar.",
            },
            {
              term: "Kept, not deleted",
              detail:
                "an event that vanishes upstream is held for a week before it goes, so one bad feed generation can't wipe your calendar.",
            },
            {
              term: "Your edits win",
              detail: "rename an event or reassign its course and sync will never overwrite it.",
            },
          ]}
          note="The subscription link works without a password, so it is stored and shown here the way a password would be."
        />
      ) : (
        <section className="mb-8 overflow-hidden rounded-lg border border-border bg-surface">
          <Table>
            <TableHeader className="bg-surface">
              <TableRow>
                <TableHead>Feed</TableHead>
                <TableHead className="hidden sm:table-cell">Status</TableHead>
                {/* Hidden below `sm`; the row folds both into its first cell. */}
                <TableHead className="hidden sm:table-cell">Last sync</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Entries</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {feedViews.map((feed) => (
                <FeedRow key={feed.id} feed={feed} action={updateFeed} />
              ))}
            </TableBody>
          </Table>
        </section>
      )}

      {visible.length > 0 ? (
        <section className="mb-8 rounded-lg border border-border bg-surface">
          <h2 className="border-border border-b px-4 py-3 font-medium text-foreground text-ui-base">
            Next {LIST_DAYS_AHEAD} days
          </h2>
          <ol className="divide-y divide-border">
            {visible.map((occurrence) => {
              const item = occurrence.calendar_items;
              const course = item.courses;
              return (
                <li
                  key={occurrence.id}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5"
                >
                  <span className="w-28 shrink-0 font-mono text-muted-foreground text-ui-sm tabular-nums">
                    {formatDay(occurrence.starts_at, timeZone)}
                  </span>
                  <span className="w-14 shrink-0 font-mono text-muted-foreground text-ui-sm tabular-nums">
                    {occurrence.all_day ? "all day" : formatTime(occurrence.starts_at, timeZone)}
                  </span>
                  <span
                    className={
                      occurrence.status === "cancelled"
                        ? "text-muted-foreground line-through"
                        : "text-foreground"
                    }
                  >
                    {item.title || "Untitled"}
                  </span>
                  {course ? (
                    <span className="flex items-center gap-1.5 text-muted-foreground text-ui-sm">
                      <CourseDot color={course.color} />
                      {course.title}
                    </span>
                  ) : (
                    <Badge variant="outline">Unassigned</Badge>
                  )}
                  {occurrence.status === "cancelled" ? (
                    <Badge variant="destructive">Cancelled</Badge>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}

      <section className="rounded-lg border border-border bg-surface p-4">
        <h3 className="mb-4 font-medium text-foreground text-ui-base">Add a feed</h3>
        <FeedCreateForm action={createFeed} />
      </section>
    </>
  );
}
