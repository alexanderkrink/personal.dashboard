import { ThisWeek } from "@/components/calendar/this-week";
import { PageHeader } from "@/components/page-header";

/**
 * The cockpit.
 *
 * §7: the "This week" view *"lives as the top section of the dashboard (and
 * standalone at /calendar)"*. It is the same component in both places, so the
 * two can never drift into disagreeing about what is due.
 *
 * The exam panel and the unassigned bucket are suppressed here: both are
 * *maintenance* surfaces — reconciling detection, filing unmatched events — and
 * the dashboard is a triage surface. They live on `/calendar`, one click away.
 */
export default function DashboardPage() {
  return (
    <>
      <PageHeader
        title="Dashboard"
        lead="The cockpit: what is due, what is next, and what to do about it."
      />
      <ThisWeek showExams={false} showUnassigned={false} />
    </>
  );
}
