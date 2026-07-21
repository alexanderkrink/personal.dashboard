import { ArrowLeft } from "@phosphor-icons/react/dist/ssr";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExamWeightSlider } from "@/components/topic-page/exam-weight-slider";
import { NeedsReviewChip } from "@/components/topic-page/grounding-banner";
import { HistoryDrawer } from "@/components/topic-page/history-drawer";
import { READING_COLUMN_CLASS } from "@/components/topic-page/reading-layout";
import { TopicPageBody } from "@/components/topic-page/topic-page-body";
import { createClient } from "@/lib/supabase/server";
import {
  buildTopicView,
  topicDocumentRowSchema,
  topicRevisionRowSchema,
  topicRowSchema,
} from "@/lib/topics/topic-view";

/**
 * A topic page — PLAN's `/courses/[id]/topics/…`, and the first consumer of the `.reading`
 * register that item 13b built in Wave 1 and left without one.
 *
 * ## The route fetches; it does not decide
 *
 * Every judgement about what the fetched rows *mean* lives in `lib/topics/topic-view.ts`
 * and `@study/core`'s `analyseProvenance`. This file is deliberately dull, because the
 * interesting logic has to be testable against the frozen Wave 4 corpus and a React Server
 * Component that awaits Supabase cannot be pointed at a JSON fixture.
 *
 * ## Reading the topic's documents
 *
 * `topic_sources` is the join that says which documents fed this topic, and it is read
 * rather than inferred from the page's own citations — otherwise a page citing a document
 * that never fed it would make that document *appear* legitimate simply by being cited,
 * which is the exact circularity `analyseProvenance` exists to break.
 */

type Params = Promise<{ id: string; slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id, slug } = await params;
  const supabase = await createClient();
  const { data } = await supabase
    .from("topics")
    .select("title")
    .eq("course_id", id)
    .eq("slug", slug)
    .maybeSingle();

  return { title: data?.title ?? "Topic" };
}

const TOPIC_COLUMNS =
  "id, course_id, title, slug, summary, page, exam_weight, exam_weight_override, revision, updated_at";
const DOCUMENT_COLUMNS =
  "id, filename, session_label, kind, status, extraction_fidelity, failure_reason, coverage, extraction, failed_topics, created_at";
const REVISION_COLUMNS =
  "id, revision, page, change_summary, source, needs_review, review_notes, document_id, prompt_id, prompt_version, model, created_at";

export default async function TopicPage({ params }: { params: Params }) {
  const { id, slug } = await params;
  const supabase = await createClient();

  const { data: topicRow } = await supabase
    .from("topics")
    .select(TOPIC_COLUMNS)
    .eq("course_id", id)
    .eq("slug", slug)
    .maybeSingle();

  const topic = topicRowSchema.safeParse(topicRow);
  if (!topic.success) notFound();

  const [{ data: course }, { data: sourceRows }, { data: revisionRows }] = await Promise.all([
    supabase.from("courses").select("title").eq("id", id).maybeSingle(),
    supabase.from("topic_sources").select("document_id").eq("topic_id", topic.data.id),
    supabase
      .from("topic_revisions")
      .select(REVISION_COLUMNS)
      .eq("topic_id", topic.data.id)
      .order("revision", { ascending: false }),
  ]);

  const documentIds = (sourceRows ?? []).map((row) => row.document_id);
  const { data: documentRows } =
    documentIds.length === 0
      ? { data: [] }
      : await supabase.from("documents").select(DOCUMENT_COLUMNS).in("id", documentIds);

  // Every jsonb column here was written by an earlier version of this code or by a model,
  // so a row that no longer parses is dropped rather than allowed to blank the page.
  const documents = (documentRows ?? []).flatMap((row) => {
    const parsed = topicDocumentRowSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
  const revisions = (revisionRows ?? []).flatMap((row) => {
    const parsed = topicRevisionRowSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });

  const view = buildTopicView({ topic: topic.data, documents, revisions });

  return (
    <div className="reading -m-4 min-h-full p-4 sm:-m-6 sm:p-6">
      <div className={READING_COLUMN_CLASS}>
        <header className="mb-8 space-y-3 font-sans">
          <Link
            className="inline-flex items-center gap-1 text-muted-foreground text-ui-sm hover:text-foreground"
            href={`/courses/${id}`}
          >
            <ArrowLeft aria-hidden className="size-3.5" />
            {course?.title ?? "Course"}
          </Link>

          <div className="flex flex-wrap items-start justify-between gap-3">
            <h1 className="font-serif font-semibold text-read-h1">{view.title}</h1>
            <div className="flex items-center gap-2">
              <NeedsReviewChip view={view} />
              <HistoryDrawer
                courseId={id}
                currentPage={view.page}
                currentRevision={view.revision}
                revisions={view.revisions}
                slug={slug}
                topicId={view.id}
              />
            </div>
          </div>

          {view.historyMissingForFirstVersion ? (
            <p className="text-muted-foreground text-ui-xs">
              Revision {view.revision} · no earlier version was recorded
            </p>
          ) : (
            <p className="text-muted-foreground text-ui-xs">
              Revision {view.revision} · {view.revisions.length} recorded change
              {view.revisions.length === 1 ? "" : "s"}
            </p>
          )}
        </header>

        <TopicPageBody view={view} />

        <section className="mt-10 border-border border-t pt-6">
          <ExamWeightSlider
            computed={view.examWeight}
            courseId={id}
            override={view.examWeightOverride}
            slug={slug}
            topicId={view.id}
          />
        </section>
      </div>
    </div>
  );
}
