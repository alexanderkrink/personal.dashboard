import { PencilSimple } from "@phosphor-icons/react/dist/ssr";
import { sumWeightPercent } from "@study/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createAssessment, updateAssessment } from "@/app/(app)/courses/[id]/actions";
import { extractSyllabus } from "@/app/(app)/courses/[id]/syllabus-actions";
import { setCourseArchived } from "@/app/(app)/courses/actions";
import { ButtonLink } from "@/components/button-link";
import { AssessmentCreateForm } from "@/components/courses/assessment-create-form";
import { AssessmentRow } from "@/components/courses/assessment-row";
import { CourseArchiveForm } from "@/components/courses/course-archive-form";
import { CourseDot } from "@/components/courses/course-dot";
import { formatCredits, formatTermDate } from "@/components/courses/format";
import { SyllabusExtractForm } from "@/components/courses/syllabus-extract-form";
import {
  SyllabusProposal,
  type SyllabusProposalView,
} from "@/components/courses/syllabus-proposal";
import { WeightTotal } from "@/components/courses/weight-total";
import { PageHeader } from "@/components/page-header";
import { TopicList } from "@/components/topic-page/topic-list";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { GRADING_SCALES } from "@/lib/courses/schemas";
import { createClient } from "@/lib/supabase/server";
import { toTopicListItem } from "@/lib/topics/topic-list";

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

  // `confirmed` filters this list, and that filter is load-bearing rather than
  // cosmetic. An unconfirmed syllabus extraction is a *proposal*; letting it into
  // this table would put it into the weight total, and the total is what the grade
  // cockpit does its arithmetic against — which is exactly the silent corruption
  // the §2b confirm gate exists to prevent. Proposals render in their own panel.
  const { data: assessments } = await supabase
    .from("assessments")
    .select("id, title, kind, weight_percent, due_hint")
    .eq("course_id", course.id)
    .eq("confirmed", true)
    .order("created_at", { ascending: true });

  const { data: proposals } = await supabase
    .from("syllabus_extractions")
    .select(
      "id, source_label, extracted_course_title, proposed_total_sessions, total_sessions_evidence, notes, model, components:syllabus_extraction_components (id, source_snippet, session_note, assessment:assessments (id, title, kind, weight_percent, session_number))",
    )
    .eq("course_id", course.id)
    .is("confirmed_at", null)
    .order("created_at", { ascending: false });

  const { data: topicRows } = await supabase
    .from("topics")
    .select("id, slug, title, summary, exam_weight, exam_weight_override, page")
    .eq("course_id", course.id)
    .order("exam_weight", { ascending: false });

  // `needs_review` lives on `topic_revisions`, not on `topics`, so the flag is read from
  // the newest revision of each topic. A topic with NO revisions is not "clean" — it is a
  // topic whose creation was never snapshotted (see `HistoryDrawer`) — but the list has no
  // honest way to say more than "not flagged", so it does not try.
  const { data: flaggedRows } =
    (topicRows ?? []).length === 0
      ? { data: [] }
      : await supabase
          .from("topic_revisions")
          .select("topic_id, revision, needs_review")
          .in(
            "topic_id",
            (topicRows ?? []).map((row) => row.id),
          )
          .order("revision", { ascending: false });

  const newestRevision = new Map<string, boolean>();
  for (const row of flaggedRows ?? []) {
    if (!newestRevision.has(row.topic_id)) newestRevision.set(row.topic_id, row.needs_review);
  }

  const topics = (topicRows ?? []).map((row) =>
    toTopicListItem(row, newestRevision.get(row.id) ?? false),
  );

  const rows = assessments ?? [];
  const total = sumWeightPercent(rows.map((row) => row.weight_percent));
  const pending = (proposals ?? []).map(toProposalView);
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

      {pending.length > 0 ? (
        <section className="mb-6 space-y-4">
          {pending.map((proposal) => (
            <SyllabusProposal key={proposal.id} proposal={proposal} courseId={course.id} />
          ))}
        </section>
      ) : null}

      <section className="mb-6 space-y-3">
        <div>
          <h3 className="font-medium text-foreground text-ui-lg">Topics</h3>
          <p className="max-w-prose text-muted-foreground text-ui-sm">
            The course's knowledge base, built from every document you upload. A flagged row is one
            whose sourcing did not hold up — open it to see why.
          </p>
        </div>
        <TopicList courseId={course.id} topics={topics} />
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
              <TableHeader className="bg-surface">
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

        <div className="rounded-lg border border-border bg-surface p-4">
          <h4 className="font-medium text-foreground text-ui-base">Extract from a syllabus</h4>
          <p className="mt-1 mb-4 max-w-prose text-muted-foreground text-ui-sm">
            Paste a syllabus and the components come back proposed, each with the line of the
            document it came from, for you to confirm.
          </p>
          <SyllabusExtractForm courseId={course.id} action={extractSyllabus} />
        </div>
      </section>
    </>
  );
}

/**
 * One extraction row + its nested components → what the proposal panel renders.
 *
 * The `assessment` join can be null in the type PostgREST infers even though the FK is
 * `not null`, so components whose assessment did not come back are dropped rather than
 * rendered half-empty. In practice that set is always empty — `apply_syllabus_extraction`
 * writes both rows in one transaction — but a proposal that silently showed a weight
 * without its snippet, or a snippet without its weight, would be the one failure mode
 * the confirm gate cannot tolerate.
 */
function toProposalView(row: {
  id: string;
  source_label: string;
  extracted_course_title: string;
  proposed_total_sessions: number | null;
  total_sessions_evidence: string | null;
  notes: string | null;
  model: string;
  components: {
    id: string;
    source_snippet: string;
    session_note: string | null;
    assessment: {
      id: string;
      title: string;
      kind: string;
      weight_percent: number;
      session_number: number | null;
    } | null;
  }[];
}): SyllabusProposalView {
  return {
    id: row.id,
    sourceLabel: row.source_label,
    extractedCourseTitle: row.extracted_course_title,
    proposedTotalSessions: row.proposed_total_sessions,
    totalSessionsEvidence: row.total_sessions_evidence,
    notes: row.notes,
    model: row.model,
    components: row.components.flatMap((component) =>
      component.assessment === null
        ? []
        : [
            {
              id: component.id,
              title: component.assessment.title,
              kind: component.assessment.kind,
              weightPercent: component.assessment.weight_percent,
              sessionNumber: component.assessment.session_number,
              sourceSnippet: component.source_snippet,
              sessionNote: component.session_note,
            },
          ],
    ),
  };
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-muted-foreground text-ui-sm">{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </span>
  );
}
