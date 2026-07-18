import { PencilSimple } from "@phosphor-icons/react/dist/ssr";
import { sumWeightPercent } from "@study/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createAssessment, updateAssessment } from "@/app/(app)/courses/[id]/actions";
import { setCourseArchived } from "@/app/(app)/courses/actions";
import { ButtonLink } from "@/components/button-link";
import { AssessmentCreateForm } from "@/components/courses/assessment-create-form";
import { AssessmentRow } from "@/components/courses/assessment-row";
import { CourseArchiveForm } from "@/components/courses/course-archive-form";
import { CourseDot } from "@/components/courses/course-dot";
import { formatCredits, formatTermDate } from "@/components/courses/format";
import { WeightTotal } from "@/components/courses/weight-total";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { GRADING_SCALES } from "@/lib/courses/schemas";
import { createClient } from "@/lib/supabase/server";

/**
 * The tab title is the course, which means a second read of the same row.
 * Next dedupes it against the one in the page body within a single render, so
 * this costs a cache lookup rather than a round-trip.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase.from("courses").select("title").eq("id", id).maybeSingle();

  return { title: data?.title ?? "Course" };
}

export default async function CoursePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: course } = await supabase
    .from("courses")
    .select("*, semester:semesters (name, starts_on, ends_on)")
    .eq("id", id)
    .maybeSingle();

  if (!course) notFound();

  const { data: assessments } = await supabase
    .from("assessments")
    .select("id, title, kind, weight_percent, due_hint")
    .eq("course_id", course.id)
    .order("created_at", { ascending: true });

  const rows = assessments ?? [];
  const total = sumWeightPercent(rows.map((row) => row.weight_percent));
  const scale = GRADING_SCALES.find((entry) => entry.value === course.grading_scale);

  return (
    <>
      <PageHeader
        title={course.title}
        lead={course.code ?? undefined}
        action={
          <>
            <CourseArchiveForm
              courseId={course.id}
              archived={course.archived}
              action={setCourseArchived}
            />
            <ButtonLink variant="outline" href={`/courses/${course.id}/edit`}>
              <PencilSimple aria-hidden="true" />
              Edit
            </ButtonLink>
          </>
        }
      />

      <section className="mb-6 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-border bg-surface px-4 py-3 text-ui-base">
        <span className="flex items-center gap-2">
          <CourseDot color={course.color} label />
          <span className="text-muted-foreground">
            {course.semester?.name ? (
              <>
                {course.semester.name}{" "}
                <span className="font-mono text-mono-data">
                  {formatTermDate(course.semester.starts_on)} —{" "}
                  {formatTermDate(course.semester.ends_on)}
                </span>
              </>
            ) : (
              "No semester"
            )}
          </span>
        </span>

        <Fact label="ECTS" value={course.credits === null ? "—" : formatCredits(course.credits)} />
        <Fact label="Scale" value={scale?.label ?? course.grading_scale} />
        <Fact
          label="Target"
          value={course.target_grade === null ? "—" : String(course.target_grade)}
        />
        {course.archived ? <Badge variant="outline">Archived</Badge> : null}
      </section>

      <section className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h3 className="font-medium text-foreground text-ui-lg">Assessments</h3>
            <p className="max-w-prose text-muted-foreground text-ui-sm">
              The graded components of this course. Weights are what the grade cockpit does its
              arithmetic against.
            </p>
          </div>
          <WeightTotal total={total} count={rows.length} />
        </div>

        {rows.length === 0 ? (
          <p className="rounded-lg border border-border border-dashed bg-surface px-4 py-6 text-muted-foreground text-ui-base">
            Nothing graded yet. Add the components from the syllabus — a midterm, a project, a final
            — and the weights below will start adding up.
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-surface">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-surface">
                <TableRow>
                  <TableHead>Component</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead className="text-right">Weight</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <AssessmentRow
                    key={row.id}
                    courseId={course.id}
                    action={updateAssessment}
                    assessment={{
                      id: row.id,
                      title: row.title,
                      kind: row.kind,
                      weightPercent: row.weight_percent,
                      dueHint: row.due_hint,
                    }}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <div className="rounded-lg border border-border bg-surface p-4">
          <h4 className="mb-4 font-medium text-foreground text-ui-base">Add a component</h4>
          <AssessmentCreateForm courseId={course.id} action={createAssessment} />
        </div>
      </section>
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-muted-foreground text-ui-sm">{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </span>
  );
}
