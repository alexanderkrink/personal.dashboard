import { FileText } from "@phosphor-icons/react/dist/ssr";
import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Documents" };

/**
 * Teaching empty state. Route only — no storage bucket, no upload surface and
 * no ingestion pipeline is wired here; that is a later wave.
 */
export default function DocumentsPage() {
  return (
    <>
      <PageHeader
        title="Documents"
        lead="Lecture slides, readings and notes — the raw material everything else is built from."
      />
      <EmptyState
        icon={FileText}
        headline="Nothing uploaded yet."
        body="Drop a lecture deck or a reading here and it stops being a file you have to remember: it gets split, indexed, and cited back to you with the slide number."
        points={[
          { term: "Upload", detail: "PDFs, slides and notes, filed against a course." },
          {
            term: "Extract",
            detail: "text and structure pulled out, then split into passages worth quoting.",
          },
          {
            term: "Provenance",
            detail: "every passage keeps its locator, so an answer can point at 'slide 12'.",
          },
          { term: "Search", detail: "meaning-based, across everything you have ever uploaded." },
        ]}
        note="The document pipeline is the back half of this milestone. This page is the route it will land on — uploading isn't live yet."
        cta={{ href: "/courses", label: "Set up courses first" }}
      />
    </>
  );
}
