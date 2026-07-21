import {
  Function as FunctionIcon,
  Lightning,
  Question,
  Warning,
} from "@phosphor-icons/react/dist/ssr";
import type { ExamReview } from "@study/ai";
import Link from "next/link";
import { Markdown } from "@/components/topic-page/markdown";
import { Badge } from "@/components/ui/badge";

/**
 * The rendered exam review (PLAN §9), in the reading register — the same Newsreader/`.reading`
 * surface as a topic page, so the guide reads like a book rather than a form.
 *
 * ## Why it takes only props
 *
 * The route fetches and validates; this renders. It never awaits, so it can be handed a
 * fixture `ExamReview` and asserted in jsdom — and, more to the point, the click-through §9
 * requires ("Every item carries topic ids") is only real if an id that resolves to a topic
 * becomes a link and one that does not degrades to plain text. That branch is testable here and
 * nowhere upstream.
 *
 * KaTeX comes free: every markdown string flows through the shared `Markdown` renderer, whose
 * remark-math + rehype-katex chain typesets `$…$` in prose and `$$…$$` in the formula sheet.
 */

const DEPTH_LABEL: Record<ExamReview["sections"][number]["depth"], string> = {
  deep: "High priority",
  standard: "Standard",
  brief: "Brief",
};

const KIND_LABEL: Record<ExamReview["questionBank"][number]["kind"], string> = {
  conceptual: "Concept",
  numeric: "Numeric",
  applied: "Applied",
};

export interface ReviewTopicRef {
  readonly slug: string;
  readonly title: string;
}

/** The click-through chips §9 asks for: a resolvable id becomes a link, an unknown one is text. */
function TopicChips({
  courseId,
  topicIds,
  topics,
}: {
  courseId: string;
  topicIds: readonly string[];
  topics: ReadonlyMap<string, ReviewTopicRef>;
}) {
  if (topicIds.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5 font-sans">
      {topicIds.map((id) => {
        const topic = topics.get(id);
        if (topic === undefined) return null;
        return (
          <Badge
            key={id}
            variant="outline"
            render={<Link href={`/courses/${courseId}/topics/${topic.slug}`}>{topic.title}</Link>}
          />
        );
      })}
    </div>
  );
}

function SectionHeading({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <h2 className="flex items-center gap-2 font-sans font-semibold text-read-h2">
      {icon}
      {children}
    </h2>
  );
}

export function ExamReviewView({
  review,
  courseId,
  topics,
}: {
  review: ExamReview;
  courseId: string;
  topics: ReadonlyMap<string, ReviewTopicRef>;
}) {
  return (
    <div className="space-y-10">
      {review.overview.trim() === "" ? null : (
        <p className="text-read-body italic" data-testid="review-overview">
          {review.overview}
        </p>
      )}

      {/* ── Prioritized topic sections ─────────────────────────────────────── */}
      {review.sections.length > 0 ? (
        <section className="space-y-8" data-testid="review-sections">
          {review.sections.map((section) => (
            <article key={`${section.topicIds.join("|")}:${section.title}`} className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-semibold text-read-h3">{section.title}</h3>
                <Badge variant={section.depth === "deep" ? "secondary" : "outline"}>
                  {DEPTH_LABEL[section.depth]}
                </Badge>
              </div>

              {section.notes.trim() === "" ? null : (
                <div className="text-read-body">
                  <Markdown>{section.notes}</Markdown>
                </div>
              )}

              {section.formulas.trim() === "" ? null : (
                <div className="overflow-x-auto text-read-body">
                  <Markdown>{section.formulas}</Markdown>
                </div>
              )}

              {section.workedExample === null || section.workedExample.trim() === "" ? null : (
                <div className="border-border border-l-2 pl-3 text-read-body">
                  <p className="mb-1 font-sans font-medium text-muted-foreground text-ui-xs uppercase tracking-wide">
                    Worked example
                  </p>
                  <Markdown>{section.workedExample}</Markdown>
                </div>
              )}

              {section.pitfalls.trim() === "" ? null : (
                <div className="rounded-md border border-warning/40 bg-warning/8 p-3 text-read-body">
                  <p className="mb-1 font-sans font-medium text-ui-xs text-warning uppercase tracking-wide">
                    Pitfalls
                  </p>
                  <Markdown>{section.pitfalls}</Markdown>
                </div>
              )}

              <TopicChips courseId={courseId} topicIds={section.topicIds} topics={topics} />
            </article>
          ))}
        </section>
      ) : null}

      {/* ── Consolidated formula sheet ─────────────────────────────────────── */}
      {review.formulaSheet.length > 0 ? (
        <section
          className="space-y-4 border-border border-t pt-6"
          data-testid="review-formula-sheet"
        >
          <SectionHeading icon={<FunctionIcon aria-hidden className="size-4" />}>
            Formula sheet
          </SectionHeading>
          {review.formulaSheet.map((formula) => (
            <div key={`${formula.topicIds.join("|")}:${formula.name}`} className="space-y-1">
              <p className="font-semibold text-read-body">{formula.name}</p>
              {formula.latex.trim() === "" ? null : (
                <div className="overflow-x-auto text-read-body">
                  <Markdown>{`$$${formula.latex}$$`}</Markdown>
                </div>
              )}
              <p className="text-read-cap">{formula.meaning}</p>
              <TopicChips courseId={courseId} topicIds={formula.topicIds} topics={topics} />
            </div>
          ))}
        </section>
      ) : null}

      {/* ── Likely-exam-questions bank ─────────────────────────────────────── */}
      {review.questionBank.length > 0 ? (
        <section
          className="space-y-4 border-border border-t pt-6"
          data-testid="review-question-bank"
        >
          <SectionHeading icon={<Question aria-hidden className="size-4" />}>
            Likely questions
          </SectionHeading>
          {review.questionBank.map((question) => (
            <div key={`${question.topicIds.join("|")}:${question.question}`} className="space-y-1">
              <div className="flex items-start gap-2">
                <Badge variant="outline" className="mt-0.5 shrink-0">
                  {KIND_LABEL[question.kind]}
                </Badge>
                <div className="text-read-body">
                  <Markdown>{question.question}</Markdown>
                </div>
              </div>
              <details className="ml-1 border-border border-l-2 pl-3">
                <summary className="cursor-pointer font-sans text-muted-foreground text-ui-sm">
                  Show answer
                </summary>
                <div className="mt-1 text-read-body">
                  <Markdown>{question.answer}</Markdown>
                </div>
              </details>
              <TopicChips courseId={courseId} topicIds={question.topicIds} topics={topics} />
            </div>
          ))}
        </section>
      ) : null}

      {/* ── Weak spots ─────────────────────────────────────────────────────── */}
      {review.weakSpots.length > 0 ? (
        <section className="space-y-4 border-border border-t pt-6" data-testid="review-weak-spots">
          <SectionHeading icon={<Warning aria-hidden className="size-4" />}>
            Weak spots
          </SectionHeading>
          {review.weakSpots.map((spot) => (
            <div
              key={`${spot.topicIds.join("|")}:${spot.issue}`}
              className="rounded-md border border-warning/40 bg-warning/8 p-3"
            >
              <p className="flex items-start gap-2 font-semibold text-read-body">
                <Lightning aria-hidden className="mt-1 size-4 shrink-0 text-warning" />
                <span>{spot.issue}</span>
              </p>
              <p className="mt-1 text-read-cap">{spot.suggestion}</p>
              <TopicChips courseId={courseId} topicIds={spot.topicIds} topics={topics} />
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}
