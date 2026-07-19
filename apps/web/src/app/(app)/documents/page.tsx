import { FileText } from "@phosphor-icons/react/dist/ssr";
import type { Metadata } from "next";
import { DocumentsPanel } from "@/components/documents/documents-panel";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { requireUserId } from "@/lib/auth/require-user";
import type { DocumentRow } from "@/lib/documents/use-document-feed";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Documents" };

const DOCUMENT_COLUMNS =
  "id, course_id, filename, kind, status, mime_type, size_bytes, failure_reason, deep_review, extraction_fidelity, coverage, created_at, processed_at";

/**
 * The documents screen (M1 item 5b).
 *
 * Server-renders the course list and the first course's documents so the page is
 * correct on first paint; `DocumentsPanel` takes over from there with Realtime.
 * Archived courses are excluded — uploading to a finished course is almost
 * always a mis-click, and the picker is the wrong place to argue about it.
 */
export default async function DocumentsPage() {
  const supabase = await createClient();
  const userId = await requireUserId(supabase);

  const { data: courses } = await supabase
    .from("courses")
    .select("id, title")
    .eq("archived", false)
    .order("title");

  const courseList = courses ?? [];
  const firstCourse = courseList[0];

  if (!firstCourse) {
    return (
      <>
        <PageHeader
          title="Documents"
          lead="Lecture slides, readings and notes — the raw material everything else is built from."
        />
        <EmptyState
          icon={FileText}
          headline="Add a course first."
          body="Documents are filed against a course, because everything built from them — topic pages, search, the exam review — is per-course."
          points={[
            { term: "Upload", detail: "PDFs and slide decks, straight to storage." },
            { term: "Check", detail: "format, size and readability, before anything is billed." },
            { term: "Track", detail: "live status while the pipeline works." },
          ]}
          cta={{ href: "/courses/new", label: "Create a course" }}
        />
      </>
    );
  }

  const { data: documents } = await supabase
    .from("documents")
    .select(DOCUMENT_COLUMNS)
    .eq("course_id", firstCourse.id)
    .order("created_at", { ascending: false });

  return (
    <>
      <PageHeader
        title="Documents"
        lead="Lecture slides, readings and notes — the raw material everything else is built from."
      />
      <DocumentsPanel
        courses={courseList}
        userId={userId}
        initialCourseId={firstCourse.id}
        initialDocuments={(documents ?? []) as DocumentRow[]}
      />
    </>
  );
}
