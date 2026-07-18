import { CalendarBlank } from "@phosphor-icons/react/dist/ssr";
import type { Metadata } from "next";
import { createSemester, updateSemester } from "@/app/(app)/courses/semesters/actions";
import { ButtonLink } from "@/components/button-link";
import { SemesterCreateForm } from "@/components/courses/semester-form";
import { SemesterRow } from "@/components/courses/semester-row";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Semesters" };

/**
 * Semesters live under `/courses` rather than at a top-level `/semesters`.
 *
 * PLAN's canonical route map reserves `/semester` (singular) for the Grade &
 * Semester Cockpit in M2, and it is explicit that feature work must not invent
 * competing names. A plural sibling of it would be exactly that. Course ids are
 * `gen_random_uuid()`, so the static `semesters` segment can never shadow a
 * real `/courses/[id]`.
 */
export default async function SemestersPage() {
  const supabase = await createClient();

  const { data: semesters } = await supabase
    .from("semesters")
    .select("id, name, starts_on, ends_on, courses (id)")
    .order("starts_on", { ascending: false });

  const rows = semesters ?? [];

  return (
    <>
      <PageHeader
        title="Semesters"
        lead="The date window a course belongs to. The planner checks exam dates against these bounds."
        action={
          <ButtonLink variant="ghost" href="/courses">
            Back to courses
          </ButtonLink>
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={CalendarBlank}
          headline="No semesters yet."
          body="A term is three facts — a name and two dates — and it is what lets the planner tell an exam inside the semester from a date that drifted in from somewhere else."
          points={[
            { term: "Name", detail: "how you say it out loud: “2026/27 Fall”." },
            {
              term: "Starts / ends",
              detail: "the bounds every exam candidate is checked against.",
            },
          ]}
          note="Courses do not need one — a course can wait for its term."
        />
      ) : (
        <section className="mb-8 overflow-hidden rounded-lg border border-border bg-surface">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-surface">
              <TableRow>
                <TableHead>Semester</TableHead>
                <TableHead>Dates</TableHead>
                <TableHead className="text-right">Courses</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((semester) => (
                <SemesterRow
                  key={semester.id}
                  action={updateSemester}
                  semester={{
                    id: semester.id,
                    name: semester.name,
                    startsOn: semester.starts_on,
                    endsOn: semester.ends_on,
                    courseCount: semester.courses.length,
                  }}
                />
              ))}
            </TableBody>
          </Table>
        </section>
      )}

      <section className="rounded-lg border border-border bg-surface p-4">
        <h3 className="mb-4 font-medium text-foreground text-ui-base">Add a semester</h3>
        <SemesterCreateForm action={createSemester} />
      </section>
    </>
  );
}
