import { CalendarBlank } from "@phosphor-icons/react/dist/ssr";
import type { Metadata } from "next";
import { createFeed, updateFeed } from "@/app/(app)/calendar/actions";
import { FeedCreateForm } from "@/components/calendar/feed-form";
import { FeedRow, type FeedView } from "@/components/calendar/feed-row";
import { NlQuickAdd } from "@/components/calendar/nl-quick-add";
import { ThisWeek } from "@/components/calendar/this-week";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { feedFingerprint, maskFeedUrl } from "@/lib/calendar/secret";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Calendar" };

/**
 * The calendar hub.
 *
 * §7's "This week" view leads, in full — including the exam panel and the
 * Unassigned bucket, which the dashboard suppresses. Feed management and
 * quick-add sit below it: they are things you do occasionally, and the week is
 * the thing you came to look at.
 *
 * The plain chronological list this page used to carry is gone. It was CAL-1's
 * evidence that sync worked; the ranked view is strictly more informative about
 * the same rows, and keeping both would have meant two answers to "what is due".
 *
 * 🔒 The feed URL never reaches this component's output. `FeedView` has no `url`
 * field; what crosses to the client is a masked origin and a non-reversible
 * fingerprint.
 */
export default async function CalendarPage() {
  const supabase = await createClient();

  const [{ data: feeds }, { data: courses }] = await Promise.all([
    supabase
      .from("calendar_feeds")
      .select(
        "id, label, config, active, last_synced_at, last_sync_status, last_sync_error, calendar_items (id)",
      )
      .order("created_at", { ascending: true }),
    supabase
      .from("courses")
      .select("id, title")
      .eq("archived", false)
      .order("title", { ascending: true }),
  ]);

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
        <ThisWeek />
      )}

      <section className="mt-8 rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-1 font-medium text-foreground text-ui-base">Add something yourself</h2>
        <p className="mb-4 text-muted-foreground text-ui-sm">
          For anything the university feed doesn’t carry — a reading, a group meeting, a
          self-imposed deadline. Say it in one line and check the form it fills in, or fill the form
          in yourself.
        </p>
        <NlQuickAdd courses={courses ?? []} />
      </section>

      {feedViews.length > 0 ? (
        <section className="mt-8 overflow-hidden rounded-lg border border-border bg-surface">
          <h2 className="border-border border-b px-4 py-3 font-medium text-foreground text-ui-base">
            Feeds
          </h2>
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
      ) : null}

      <section className="mt-8 rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-4 font-medium text-foreground text-ui-base">Add a feed</h2>
        <FeedCreateForm action={createFeed} />
      </section>
    </>
  );
}
