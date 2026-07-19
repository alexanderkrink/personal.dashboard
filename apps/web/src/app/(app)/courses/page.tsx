import { BookOpen, Plus } from "@phosphor-icons/react/dist/ssr";
import { sumWeightPercent, weightTotalVerdict } from "@study/core";
import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink } from "@/components/button-link";
import { CourseDot } from "@/components/courses/course-dot";
import { formatCredits, formatWeight, pluralize } from "@/components/courses/format";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Courses" };

/**
 * The course list. A Server Component: reads are RSC, and the only writes on
 * this surface are links to the forms that own them.
 *
 * There is no `.eq("user_id", …)` anywhere in this file. The select policies on
 * `courses`, `semesters` and `assessments` already scope every one of these
 * reads to the caller, so a filter here would be a second, weaker copy of a
 * rule the database enforces — and one free to drift out of agreement with it.
 */
export default async function CoursesPage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string }>;
}) {
  const showArchived = (await searchParams).archived === "1";
  const supabase = await createClient();

  const { data: courses } = await supabase
    .from("courses")
    .select(
      "id, code, title, color, credits, archived, semester:semesters (name), assessments (weight_percent)",
    )
    .order("archived", { ascending: true })
    .order("title", { ascending: true });

  const all = courses ?? [];
  const archivedCount = all.filter((course) => course.archived).length;
  const visible = showArchived ? all : all.filter((course) => !course.archived);

  return (
    <>
      <PageHeader
        title="Courses"
        lead="Semesters, courses, and the assessments that decide your grade."
        action={
          <>
            <ButtonLink variant="ghost" href="/courses/semesters">
              Semesters
            </ButtonLink>
            <ButtonLink href="/courses/new">
              <Plus aria-hidden="true" />
              New course
            </ButtonLink>
          </>
        }
      />

      {all.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          headline="No courses yet."
          body="A course is the spine everything else hangs off: deadlines, documents, grades and study time all attach to one."
          points={[
            { term: "Semester", detail: "the date window a course belongs to." },
            {
              term: "Assessments",
              detail: "each with a weight, so the grade cockpit can do the arithmetic.",
            },
            { term: "Colour", detail: "one of eight, reused as the course chip everywhere." },
          ]}
          cta={{ href: "/courses/new", label: "Add your first course" }}
        />
      ) : (
        <section className="overflow-hidden rounded-lg border border-border bg-surface">
          <Table>
            <TableHeader className="bg-surface">
              <TableRow>
                <TableHead>Course</TableHead>
                <TableHead>Semester</TableHead>
                <TableHead className="text-right">ECTS</TableHead>
                <TableHead className="text-right">Weights</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((course) => {
                const weights = course.assessments.map((entry) => entry.weight_percent);
                const total = sumWeightPercent(weights);
                const verdict = weightTotalVerdict(total, weights.length);

                return (
                  <TableRow key={course.id} className="hover:bg-accent-subtle">
                    <TableCell className="py-1.5">
                      <span className="flex items-center gap-2.5">
                        <CourseDot color={course.color} />
                        {/* The link is the title, not the row: a clickable
                            `<tr>` is not keyboard-reachable and is not
                            announced as a link. */}
                        <Link
                          href={`/courses/${course.id}`}
                          className="focus-ring rounded-sm font-medium text-foreground hover:text-accent"
                        >
                          {course.title}
                        </Link>
                        {course.code ? (
                          <span className="font-mono text-mono-data text-muted-foreground">
                            {course.code}
                          </span>
                        ) : null}
                        {course.archived ? <Badge variant="outline">Archived</Badge> : null}
                      </span>
                    </TableCell>
                    <TableCell className="py-1.5 text-muted-foreground">
                      {course.semester?.name ?? "—"}
                    </TableCell>
                    <TableCell className="py-1.5 text-right font-mono tabular-nums">
                      {course.credits === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        formatCredits(course.credits)
                      )}
                    </TableCell>
                    <TableCell className="py-1.5 text-right">
                      {weights.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span
                          className={cn(
                            "font-mono tabular-nums",
                            verdict === "balanced" ? "text-muted-foreground" : "text-warning",
                          )}
                          title={pluralize(weights.length, "component")}
                        >
                          {formatWeight(total)}%
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </section>
      )}

      {archivedCount > 0 ? (
        <p className="mt-4 text-ui-sm">
          <Link
            href={showArchived ? "/courses" : "/courses?archived=1"}
            className="focus-ring rounded-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {showArchived
              ? "Hide archived courses"
              : `Show ${pluralize(archivedCount, "archived course")}`}
          </Link>
        </p>
      ) : null}
    </>
  );
}
