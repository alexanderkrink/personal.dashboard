import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { updateCourse } from "@/app/(app)/courses/actions";
import { CourseForm } from "@/components/courses/course-form";
import { PageHeader } from "@/components/page-header";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Edit course" };

/** A number column → the string the form field holds. `null` means blank. */
function text(value: number | string | null): string {
  return value === null ? "" : String(value);
}

export default async function EditCoursePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: course }, { data: semesters }] = await Promise.all([
    supabase.from("courses").select("*").eq("id", id).maybeSingle(),
    supabase.from("semesters").select("id, name").order("starts_on", { ascending: false }),
  ]);

  // Not "forbidden": the select policy makes another account's course
  // indistinguishable from one that was never there, and saying which it is
  // would confirm the row exists.
  if (!course) notFound();

  return (
    <>
      <PageHeader title="Edit course" lead={course.title} />

      <CourseForm
        action={updateCourse}
        courseId={course.id}
        semesters={semesters ?? []}
        initialValues={{
          semesterId: course.semester_id ?? "",
          code: course.code ?? "",
          title: course.title,
          color: course.color,
          credits: text(course.credits),
          targetGrade: text(course.target_grade),
          gradingScale: course.grading_scale,
          participationWeight: text(course.participation_weight),
          absenceFailPct: text(course.absence_fail_pct),
          participationTarget: text(course.participation_target),
        }}
        submitLabel="Save changes"
      />
    </>
  );
}
