import type { Metadata } from "next";
import Link from "next/link";
import { createCourse } from "@/app/(app)/courses/actions";
import { CourseForm } from "@/components/courses/course-form";
import { PageHeader } from "@/components/page-header";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "New course" };

export default async function NewCoursePage() {
  const supabase = await createClient();

  // RLS scopes this to the caller's terms, so the picker can only ever offer a
  // semester the user owns — and the action re-checks on the way in, because a
  // form field is not a permission.
  const { data: semesters } = await supabase
    .from("semesters")
    .select("id, name")
    .order("starts_on", { ascending: false });

  return (
    <>
      <PageHeader
        title="New course"
        lead="Only the title is required. Everything else can wait until the syllabus turns up."
      />

      {semesters?.length === 0 ? (
        <p className="mb-6 max-w-prose text-muted-foreground text-ui-sm">
          No semesters yet — a course can wait for its term.{" "}
          <Link
            href="/courses/semesters"
            className="focus-ring rounded-sm text-foreground underline underline-offset-4"
          >
            Add one
          </Link>{" "}
          when you want the planner to know when the term ends.
        </p>
      ) : null}

      <CourseForm action={createCourse} semesters={semesters ?? []} submitLabel="Create course" />
    </>
  );
}
