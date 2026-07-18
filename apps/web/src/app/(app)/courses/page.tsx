import { BookOpen } from "@phosphor-icons/react/dist/ssr";
import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Courses" };

/**
 * Scaffold only — courses CRUD (PLAN item 1b) is a separate work item and a
 * later agent owns this file. The shell contract it must keep: a `PageHeader`
 * and content that flows in the `(app)` group's `<main>`.
 */
export default function CoursesPage() {
  return (
    <>
      <PageHeader
        title="Courses"
        lead="Semesters, courses, and the assessments that decide your grade."
      />
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
        note="Adding and editing courses arrives next in this milestone."
      />
    </>
  );
}
