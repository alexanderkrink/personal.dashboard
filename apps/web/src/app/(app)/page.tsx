import { CalendarBlank } from "@phosphor-icons/react/dist/ssr";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export default function DashboardPage() {
  return (
    <>
      <PageHeader
        title="Dashboard"
        lead="The cockpit: what is due, what is next, and what to do about it."
      />
      <EmptyState
        icon={CalendarBlank}
        headline="Nothing to triage yet."
        body="This is where the week lands — deadlines ranked by what actually matters, not by whatever happens to fall first on the calendar."
        points={[
          {
            term: "Overdue",
            detail: "pinned in danger red, carried forward until you finish or dismiss it.",
          },
          {
            term: "This week",
            detail: "hairline rows sorted by priority score, each with a mono countdown.",
          },
          {
            term: "On the horizon",
            detail: "the next 14 days, medium weight and up, so nothing ambushes you.",
          },
        ]}
        note="Add a course and its assessments and this fills itself in."
        cta={{ href: "/courses", label: "Set up courses" }}
      />
    </>
  );
}
