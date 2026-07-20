import { ArrowClockwise, Eye, Warning, WarningOctagon } from "@phosphor-icons/react/dist/ssr";
import { MINIMUM_MAPPED_RATIO } from "@study/core";
import { gapLabel } from "@/lib/documents/coverage";
import type { TopicView } from "@/lib/topics/topic-view";
import { coverageEntries } from "@/lib/topics/topic-view";
import { cn } from "@/lib/utils";

/**
 * The page-level grounding banners — everything a reader needs to know *before* they start
 * trusting the prose below.
 *
 * ## Why these sit above the page and not in a footer
 *
 * Because the failure mode is a student reading twelve thousand words of confident,
 * correct-looking statistics and only afterwards discovering that all of it was sourced to
 * one slide. A disclosure at the bottom is read by nobody who needed it. §8 puts coverage on
 * the *status card*; this is the same information asked of a topic instead of a document,
 * and it belongs where the reading starts.
 *
 * ## Every surface here had never been rendered before this component
 *
 * `coverage.pagesUnmapped` / `pagesSkipped` / `pagesUndeclared`, `extraction_fidelity`,
 * `needs_review`, the `partial` retry state — all shipped in Wave 4 and none of them had a
 * consumer on a topic page. They are counted as three separate facts here because Wave 5
 * corrected PLAN on exactly that point: the old event text lumped *skipped* into *unmapped*
 * and made one document read "53 unmapped" for 47 unmapped and 6 deliberately skipped.
 */

function Banner({
  tone,
  icon,
  title,
  children,
}: {
  tone: "warning" | "danger" | "info";
  icon: React.ReactNode;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-md border p-3 font-sans",
        tone === "danger" && "border-danger/40 bg-danger/8 text-danger",
        tone === "warning" && "border-warning/40 bg-warning/8 text-warning",
        tone === "info" && "border-border bg-muted/50 text-muted-foreground",
      )}
      data-banner={title}
    >
      <span aria-hidden className="mt-0.5 shrink-0">
        {icon}
      </span>
      <div className="space-y-1">
        <p className="font-semibold text-ui-base">{title}</p>
        {children}
      </div>
    </div>
  );
}

/**
 * The Wave 4 signature, stated at page level.
 *
 * This is the single most important thing this component renders. Per block, "cites p. 2"
 * looks like ordinary provenance; the defect exists only in the aggregate, so the aggregate
 * is where it has to be said, in a sentence rather than a badge.
 */
function CollapseBanner({ view }: { view: TopicView }) {
  const collapse = view.provenance.collapse;
  if (collapse === null) return null;

  return (
    <Banner
      icon={<WarningOctagon className="size-4" weight="fill" />}
      title="Every citation on this page points at one page"
      tone="danger"
    >
      <p className="text-ui-sm">{collapse.detail}</p>
      <p className="text-ui-sm">
        Treat the material below as unverified until you have checked it against the source
        yourself.
      </p>
    </Banner>
  );
}

/** Blocks that cite nothing, and chips that resolve nowhere. */
function BrokenProvenanceBanner({ view }: { view: TopicView }) {
  const { blocksWithoutSources, brokenCitationCount } = view.provenance;
  if (blocksWithoutSources === 0 && brokenCitationCount === 0) return null;

  const parts: string[] = [];
  if (blocksWithoutSources > 0) {
    parts.push(
      `${blocksWithoutSources} block${blocksWithoutSources === 1 ? "" : "s"} cite${
        blocksWithoutSources === 1 ? "s" : ""
      } nothing at all`,
    );
  }
  if (brokenCitationCount > 0) {
    parts.push(
      `${brokenCitationCount} citation${brokenCitationCount === 1 ? "" : "s"} point${
        brokenCitationCount === 1 ? "s" : ""
      } at a page or document this topic never read`,
    );
  }

  return (
    <Banner
      icon={<Warning className="size-4" weight="fill" />}
      title="Some of this page has no source"
      tone="warning"
    >
      <p className="text-ui-sm">{`${parts.join(", and ")}. Those blocks are marked below.`}</p>
    </Banner>
  );
}

/**
 * The coverage map, per feeding document, with the gaps disclosed.
 *
 * Three counts, named as themselves. The mapped ratio is stated even when it is good,
 * because a suppressed number is indistinguishable from a healthy one — which is precisely
 * how `pagesMapped: 1, pagesUnmapped: 47` shipped as `trustworthy: true` with no warning.
 */
export function CoverageMap({ view }: { view: TopicView }) {
  const entries = coverageEntries(view);
  if (entries.length === 0) return null;

  return (
    <div className="space-y-2" data-testid="coverage-map">
      {entries.map(({ document, coverage }) => {
        const mappable = Math.max(coverage.pagesTotal - coverage.pagesSkipped, 0);
        const ratio = mappable === 0 ? 1 : coverage.pagesMapped / mappable;
        const poor = ratio < MINIMUM_MAPPED_RATIO;
        const unmapped = coverage.gaps.filter((g) => g.kind === "unmapped");
        const skipped = coverage.gaps.filter((g) => g.kind === "skipped");
        const undeclared = coverage.gaps.filter((g) => g.kind === "undeclared");

        return (
          <details
            className={cn(
              "rounded-md border p-3 font-sans text-ui-sm",
              poor ? "border-warning/40 bg-warning/8" : "border-border bg-muted/40",
            )}
            data-coverage-poor={poor ? "true" : "false"}
            key={document.id}
          >
            <summary
              className={cn(
                "cursor-pointer font-medium",
                poor ? "text-warning" : "text-muted-foreground",
              )}
            >
              {poor ? (
                <Warning aria-hidden className="mr-1 inline size-3.5 align-[-2px]" weight="fill" />
              ) : null}
              {`${document.label} — ${coverage.pagesMapped} of ${coverage.pagesTotal} pages mapped`}
              {coverage.pagesUnmapped > 0 ? ` · ${coverage.pagesUnmapped} unmapped` : ""}
              {coverage.pagesSkipped > 0 ? ` · ${coverage.pagesSkipped} skipped` : ""}
              {coverage.pagesUndeclared > 0 ? ` · ${coverage.pagesUndeclared} undeclared` : ""}
            </summary>

            <div className="mt-2 space-y-2 text-muted-foreground">
              {poor ? (
                <p className="text-warning">
                  {`Most of this document reached no topic page at all. ${coverage.pagesUnmapped} pages were read and then cited by nothing.`}
                </p>
              ) : null}

              <GapList gaps={unmapped} title="Read, but no topic page cites it" tone="warning" />
              <GapList gaps={skipped} title="Deliberately skipped" tone="muted" />
              <GapList gaps={undeclared} title="Missing with nothing saying so" tone="warning" />

              {coverage.missingObjectives.length > 0 ? (
                <div>
                  <p className="font-medium text-warning">Syllabus objectives with no page yet</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    {coverage.missingObjectives.map((objective) => (
                      <li key={objective}>{objective}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {coverage.warnings.map((warning) => (
                <p className="text-warning" key={warning}>
                  {warning}
                </p>
              ))}
            </div>
          </details>
        );
      })}
    </div>
  );
}

function GapList({
  gaps,
  title,
  tone,
}: {
  gaps: ReadonlyArray<{ fromPage: number; toPage: number; reason: string }>;
  title: string;
  tone: "warning" | "muted";
}) {
  if (gaps.length === 0) return null;
  return (
    <div>
      <p className={cn("font-medium", tone === "warning" ? "text-warning" : "")}>{title}</p>
      <ul className="mt-1 space-y-0.5">
        {gaps.map((gap) => (
          <li key={`${gap.fromPage}-${gap.toPage}-${gap.reason}`}>
            <span className="font-mono text-ui-xs">{gapLabel(gap)}</span>
            <span className="ml-2">{gap.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * `documents.extraction_fidelity` — the "why does this page look thin?" explanation that
 * PLAN's §4.2 decision says must be built rather than stubbed.
 *
 * `null` renders nothing: a document processed before the column existed has no honest
 * answer, and inventing one is worse than silence.
 */
export function FidelityNotes({ view }: { view: TopicView }) {
  const notes = view.documents.flatMap((document) => {
    if (document.extractionFidelity === "text-only") {
      return [
        {
          id: document.id,
          text: `${document.label} was read from its text only. Anything that appears solely inside a diagram, chart or screenshot is not in these notes.`,
        },
      ];
    }
    if (document.extractionFidelity === "visual") {
      return [
        {
          id: document.id,
          text: `${document.label} was read visually — diagrams, charts and equations on the pages were included.`,
        },
      ];
    }
    return [];
  });

  if (notes.length === 0) return null;

  return (
    <ul className="space-y-1 font-sans text-muted-foreground text-ui-xs" data-testid="fidelity">
      {notes.map((note) => (
        <li key={note.id}>{note.text}</li>
      ))}
    </ul>
  );
}

/** §5 Step B2's "⚠ review this change" chip, read off the newest revision. */
export function NeedsReviewChip({ view }: { view: TopicView }) {
  if (view.needsReview !== true) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-sm bg-warning/12 px-1.5 py-0.5 font-sans font-medium text-ui-xs text-warning ring-1 ring-warning/40"
      data-testid="needs-review"
    >
      <Eye aria-hidden className="size-3" weight="fill" />
      Flagged for review
    </span>
  );
}

/**
 * §8's amber `partial` banner, asked of a topic rather than a document.
 *
 * ⚠ It carries **no retry button**. §8 says the retry "sends `document/retry-merges`", and
 * Wave 4 decided that event is deliberately not implemented — `retryDocument` is a
 * converging retry on the document surface instead. A button that fired nothing would be
 * worse than a sentence pointing at the surface that does work.
 */
export function PartialBanner({ view }: { view: TopicView }) {
  const partial = view.documents.filter((d) => d.status === "partial");
  if (partial.length === 0) return null;

  return (
    <Banner
      icon={<ArrowClockwise className="size-4" weight="bold" />}
      title="A document that feeds this page only half-merged"
      tone="warning"
    >
      {partial.map((document) => (
        <p className="text-ui-sm" key={document.id}>
          {`${document.label} failed to merge into ${document.failedTopicCount} topic${
            document.failedTopicCount === 1 ? "" : "s"
          }, so this page may be missing what it would have added. Retry it from the Documents page.`}
        </p>
      ))}
    </Banner>
  );
}

/** Everything above the prose, in the order a reader needs it. */
export function GroundingBanners({ view }: { view: TopicView }) {
  return (
    <div className="space-y-2">
      <CollapseBanner view={view} />
      <BrokenProvenanceBanner view={view} />
      <PartialBanner view={view} />
    </div>
  );
}
