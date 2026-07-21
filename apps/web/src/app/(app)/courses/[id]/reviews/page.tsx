import { ArrowLeft, Sparkle } from "@phosphor-icons/react/dist/ssr";
import { examReviewSchema } from "@study/ai";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExamReviewView, type ReviewTopicRef } from "@/components/exam-review/exam-review-view";
import { RegenerateReviewButton } from "@/components/exam-review/regenerate-review-button";
import { READING_COLUMN_CLASS } from "@/components/topic-page/reading-layout";
import { readSnapshot } from "@/inngest/functions/mark-reviews-stale";
import { countChangedTopics, type DatedDocument, materialsThrough } from "@/lib/reviews/staleness";
import { createClient } from "@/lib/supabase/server";

/**
 * The exam-review page — PLAN §9's reading surface. The newest review for the course, rendered
 * in the `.reading` register (Newsreader, capped-and-anchored column) exactly like a topic
 * page, with a staleness banner and a Regenerate button.
 *
 * ## The route fetches; it does not decide
 *
 * Staleness ("N topics changed since") is computed by `@study/core`-style pure helpers in
 * `lib/reviews/staleness.ts`, and the content is `safeParse`d out of the jsonb column through
 * `examReviewSchema` — a stored artifact is an external input to every future version of this
 * schema, so it is parsed, never cast.
 */

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase.from("courses").select("title").eq("id", id).maybeSingle();
  return { title: data?.title ? `Exam review — ${data.title}` : "Exam review" };
}

export default async function ReviewPage({ params }: { params: Params }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: course } = await supabase
    .from("courses")
    .select("id, title")
    .eq("id", id)
    .maybeSingle();
  if (!course) notFound();

  const [{ data: reviewRow }, { data: topicRows }, { data: documentRows }] = await Promise.all([
    supabase
      .from("exam_reviews")
      .select("id, content, topic_snapshot, stale, created_at, model")
      .eq("course_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.from("topics").select("id, slug, title, revision").eq("course_id", id),
    supabase.from("documents").select("session_label, filename, created_at").eq("course_id", id),
  ]);

  const topics = new Map<string, ReviewTopicRef>(
    (topicRows ?? []).map((row) => [row.id, { slug: row.slug, title: row.title }]),
  );
  const currentRevisions = new Map<string, number>(
    (topicRows ?? []).map((row) => [row.id, row.revision]),
  );
  const documents: DatedDocument[] = (documentRows ?? []).map((row) => ({
    sessionLabel: row.session_label,
    filename: row.filename,
    createdAt: row.created_at,
  }));

  const header = (
    <header className="mb-8 space-y-3 font-sans">
      <Link
        className="inline-flex items-center gap-1 text-muted-foreground text-ui-sm hover:text-foreground"
        href={`/courses/${id}`}
      >
        <ArrowLeft aria-hidden className="size-3.5" />
        {course.title}
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="font-serif font-semibold text-read-h1">Exam review</h1>
        <RegenerateReviewButton
          courseId={id}
          label={reviewRow ? "Regenerate" : "Generate exam review"}
        />
      </div>
    </header>
  );

  // ── Nothing generated yet ────────────────────────────────────────────────
  const parsed = reviewRow ? examReviewSchema.safeParse(reviewRow.content) : null;
  if (reviewRow === null || parsed === null || !parsed.success) {
    return (
      <div className="reading -m-4 min-h-full p-4 sm:-m-6 sm:p-6">
        <div className={READING_COLUMN_CLASS}>
          {header}
          <div className="rounded-lg border border-border border-dashed bg-surface p-6 font-sans">
            <Sparkle aria-hidden className="mb-2 size-5 text-muted-foreground" />
            <p className="text-foreground text-ui-base">
              {reviewRow === null
                ? "No exam review yet."
                : "This review couldn’t be displayed — regenerate it to rebuild it."}
            </p>
            <p className="mt-1 max-w-prose text-muted-foreground text-ui-sm">
              {topics.size === 0
                ? "Upload some course material first — the review is built from your topic pages, weighted by exam relevance."
                : "One Opus pass consolidates your topic pages into prioritized notes, a formula sheet, a likely-questions bank and a weak-spots list. It costs roughly $0.50–1.50."}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── Staleness ────────────────────────────────────────────────────────────
  const snapshot = readSnapshot(reviewRow.topic_snapshot);
  const changed = countChangedTopics(snapshot, currentRevisions);
  const isStale = reviewRow.stale || changed > 0;
  const through = materialsThrough(documents);
  const built = new Date(reviewRow.created_at).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <div className="reading -m-4 min-h-full p-4 sm:-m-6 sm:p-6">
      <div className={READING_COLUMN_CLASS}>
        {header}

        <p className="mb-4 font-sans text-muted-foreground text-ui-xs">
          {through === null ? `Generated ${built}` : `Based on materials through ${through}`}
          {" · "}
          {reviewRow.model}
        </p>

        {isStale ? (
          <div
            className="mb-6 rounded-md border border-warning/40 bg-warning/8 p-3 font-sans text-ui-sm"
            data-testid="staleness-banner"
          >
            <p className="font-medium text-warning">
              {changed === 0
                ? "The course has changed since this review was built."
                : `${changed} topic${changed === 1 ? "" : "s"} changed since this review was built.`}
            </p>
            <p className="mt-0.5 text-muted-foreground">
              Regenerate to fold the newest material in — or keep reading this one; nothing is wrong
              with it, it just predates a change.
            </p>
          </div>
        ) : null}

        <ExamReviewView review={parsed.data} courseId={id} topics={topics} />
      </div>
    </div>
  );
}
