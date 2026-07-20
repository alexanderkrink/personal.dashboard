import { ArrowRight, BookOpen, Warning } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";

/**
 * The course's topic index — the only route into a topic page.
 *
 * ## Weakness is visible here too, not only one level down
 *
 * A student picks what to revise from this list, so a page whose citations all collapsed
 * onto one slide has to be distinguishable *before* it is opened. Reproducing the whole
 * grounding analysis per row would mean fetching every topic's documents; the row instead
 * carries the two facts the list query already has — whether the newest revision was
 * flagged, and how many distinct pages the page's own blocks cite — and says so plainly.
 */

export interface TopicListItem {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly examWeight: number;
  readonly needsReview: boolean;
  /** Distinct (document, page) pairs cited anywhere on the page. */
  readonly distinctLocators: number;
  readonly blockCount: number;
}

export function TopicList({
  courseId,
  topics,
}: {
  courseId: string;
  topics: readonly TopicListItem[];
}) {
  if (topics.length === 0) {
    return (
      <EmptyState
        body="Topic pages are written by the document pipeline. Upload a deck or a reading and they appear here, growing as the term goes on."
        cta={{ href: "/documents", label: "Upload a document" }}
        headline="No topics yet"
        icon={BookOpen}
        points={[
          { term: "Upload", detail: "a lecture deck or reading on the Documents page." },
          {
            term: "Merge",
            detail: "the pipeline routes each section into a topic and writes its page.",
          },
          {
            term: "Read",
            detail: "topics accumulate across the term rather than one silo per lecture.",
          },
        ]}
      />
    );
  }

  return (
    <ul className="space-y-2">
      {topics.map((topic) => {
        // The Wave 4 shape, cheaply: many blocks, one place cited.
        const collapsed = topic.blockCount >= 3 && topic.distinctLocators === 1;
        const unsourced = topic.blockCount > 0 && topic.distinctLocators === 0;
        const weak = collapsed || unsourced || topic.needsReview;

        return (
          <li key={topic.id}>
            <Link
              className={cn(
                "flex items-start justify-between gap-3 rounded-md border p-3 transition-colors",
                weak
                  ? "border-warning/40 bg-warning/8 hover:bg-warning/12"
                  : "border-border hover:bg-muted/50",
              )}
              data-weak={weak ? "true" : "false"}
              href={`/courses/${courseId}/topics/${topic.slug}`}
            >
              <div className="min-w-0 space-y-1">
                <p className="flex items-center gap-1.5 font-medium text-ui-md">
                  {weak ? (
                    <Warning aria-hidden className="size-3.5 shrink-0 text-warning" weight="fill" />
                  ) : null}
                  {topic.title}
                </p>
                <p className="line-clamp-2 text-muted-foreground text-ui-sm">{topic.summary}</p>
                <p className="font-mono text-muted-foreground text-ui-xs">
                  {topic.needsReview ? "flagged for review · " : ""}
                  {unsourced
                    ? "nothing on this page cites a source"
                    : collapsed
                      ? "every citation points at one page"
                      : `${topic.distinctLocators} sources cited`}
                </p>
              </div>
              <ArrowRight aria-hidden className="mt-1 size-4 shrink-0 text-muted-foreground" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
