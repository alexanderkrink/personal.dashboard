import { Warning, WarningCircle } from "@phosphor-icons/react/dist/ssr";
import type { ProvenanceBlock, ProvenanceCitation, ProvenanceStrength } from "@study/core";
import { cn } from "@/lib/utils";

/**
 * Block-level provenance, rendered so that thin sourcing *looks* thin.
 *
 * ## The one design rule this file exists to enforce
 *
 * Wave 4's failure was invisible because bad output was rendered exactly as beautifully as
 * good output. A page whose twenty citations all pointed at one objectives slide got the
 * same warm serif treatment, the same tidy chips, the same confident silence as a page
 * built honestly from fifty. So the rule here is: **a block that cannot show where it came
 * from must not be given the presentation of one that can.**
 *
 * That is spent in three places, in descending order of how loudly they shout:
 *
 * 1. `absent` — no citation at all. The block gets a dashed left rule, muted ink, and a
 *    sentence saying nothing vouches for it. It is the only state that adds *prose*,
 *    because it is the only state where the reader would otherwise see nothing at all and
 *    conclude everything is fine.
 * 2. `broken` — citations that resolve nowhere. Warning ink and a strikethrough-adjacent
 *    treatment on the chip itself, because the chip is the thing that is lying.
 * 3. `single` vs `corroborated` — a weight difference, not an alarm. One source is normal.
 *    It is only damning in aggregate, and the aggregate is the page-level banner's job.
 *
 * Note what is deliberately NOT done: no green tick, no "verified" badge, no score. This
 * module can prove absence and it cannot prove support — `analyseProvenance` is arithmetic
 * over locators, not a reading of the source. A tick would claim the thing the check
 * cannot check, which is how the citation UI becomes noise.
 */

/* ────────────────────────────────────────────────────────────────────────── */
/* One chip                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * A single `Lecture 7 · p. 12` locator.
 *
 * ## It is not a link, and that is a decision rather than an omission
 *
 * PLAN §8 says the chip "deep-links to the document viewer". **There is no document
 * viewer** — `apps/web/src/app/(app)/documents/` has no `[id]` segment, and `typedRoutes`
 * would fail the build on an href to one. `document-card.tsx` already set this precedent
 * for coverage gaps and stated the reason: a link to a route that does not exist is a worse
 * answer than an honest one.
 *
 * So the chip carries the one thing it *can* honestly carry — the extracted title of the
 * page it names, as a `title` tooltip. On the Wave 4 artifact every chip therefore reads
 * `Sampling Distributions · p. 2` and reveals `Topic Goals`, which is exactly the
 * observation a student needs to make: six formulas, all sourced to the goals slide.
 */
export function ProvenanceChip({
  citation,
  pageTitle,
}: {
  citation: ProvenanceCitation;
  pageTitle?: string | undefined;
}) {
  const broken = citation.status !== "resolved";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-ui-xs",
        broken
          ? "bg-warning/10 text-warning ring-1 ring-warning/40"
          : "bg-muted text-muted-foreground",
      )}
      data-citation-status={citation.status}
      title={
        citation.status === "unread-page"
          ? "This page was never read by the extractor — the citation points nowhere."
          : citation.status === "unknown-document"
            ? "This citation names a document that did not feed this topic."
            : pageTitle === undefined || pageTitle === ""
              ? undefined
              : `On that page: ${pageTitle}`
      }
    >
      {broken ? <WarningCircle aria-hidden className="size-3" weight="fill" /> : null}
      {citation.label}
    </span>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* A block's footer                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

/** Every chip for one block, plus the sentence an unsourced block earns. */
export function BlockProvenance({
  block,
  pageTitles,
}: {
  block: ProvenanceBlock;
  pageTitles: ReadonlyMap<string, ReadonlyMap<number, string>>;
}) {
  if (block.strength === "absent") {
    return (
      <p
        className="mt-2 flex items-start gap-1.5 font-sans text-ui-xs text-warning"
        data-provenance-note="absent"
      >
        <Warning aria-hidden className="mt-px size-3.5 shrink-0" weight="fill" />
        <span>Nothing cites this. No document in this topic is recorded as its source.</span>
      </p>
    );
  }

  return (
    <p className="mt-2 flex flex-wrap items-center gap-1">
      {block.citations.map((citation) => (
        <ProvenanceChip
          citation={citation}
          key={`${citation.documentId}#${citation.page}`}
          pageTitle={
            citation.documentId === null || citation.page === null
              ? undefined
              : pageTitles.get(citation.documentId)?.get(citation.page)
          }
        />
      ))}
    </p>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The block shell                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The wrapper that makes strength visible before a word is read.
 *
 * `data-provenance` is on the element for the same reason the chip carries
 * `data-citation-status`: it is the seam a test asserts against, so "does a badly-sourced
 * block look different?" is a question with a mechanical answer rather than a screenshot.
 */
const SHELL: Record<ProvenanceStrength, string> = {
  // Dashed rule + reduced ink: unmistakably not the treatment a sourced block gets.
  absent: "border-warning/50 border-l-2 border-dashed pl-4 opacity-80",
  broken: "border-warning/50 border-l-2 pl-4",
  // The ordinary case. A hairline that reads as structure, not as a warning.
  single: "border-border border-l pl-4",
  corroborated: "border-border border-l pl-4",
};

export function ProvenanceBlockShell({
  block,
  children,
}: {
  block: ProvenanceBlock | undefined;
  children: React.ReactNode;
}) {
  const strength = block?.strength ?? "absent";
  return (
    <section className={cn("py-1", SHELL[strength])} data-provenance={strength}>
      {children}
    </section>
  );
}
