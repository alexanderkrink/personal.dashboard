import { CalendarBlank } from "@phosphor-icons/react/dist/ssr";
import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Calendar" };

/**
 * Teaching empty state. The points below are the "This week" composition from
 * PLAN.md §7, in order — this page and the top of `/` render the same view, so
 * what it promises here is what will actually appear.
 */
export default function CalendarPage() {
  return (
    <>
      <PageHeader title="Calendar" lead="Classes and deadlines for the week, in one place." />
      <EmptyState
        icon={CalendarBlank}
        headline="No feeds connected."
        body="Your timetable lives in your university's calendar, not here. Point this at that feed once and the week keeps itself current."
        points={[
          {
            term: "Sync status",
            detail: "how fresh the data is, and which feed to reconnect when one goes stale.",
          },
          {
            term: "Deadlines",
            detail: "ranked by priority, not by date — weight badge, course chip, countdown.",
          },
          {
            term: "Week grid",
            detail:
              "a compact Mon–Sun strip of classes. Deliberately quiet: classes are context, deadlines are the payload.",
          },
          {
            term: "Unassigned",
            detail: "synced events with no course match, one click from being filed.",
          },
        ]}
        note="Calendar sync arrives in this milestone. It reads a read-only ICS feed — nothing is ever written back to your university's calendar."
        cta={{ href: "/courses", label: "Set up courses first" }}
      />
    </>
  );
}
