import { Quotes, Warning } from "@phosphor-icons/react/dist/ssr";
import { sumWeightPercent } from "@study/core";
import {
  confirmSyllabusExtraction,
  rejectSyllabusExtraction,
} from "@/app/(app)/courses/[id]/syllabus-actions";
import { formatWeight, pluralize } from "@/components/courses/format";
import { SyllabusProposalActions } from "@/components/courses/syllabus-proposal-actions";
import { Badge } from "@/components/ui/badge";
import { assessmentKindLabel } from "@/lib/courses/schemas";

export type ProposedComponent = {
  id: string;
  title: string;
  kind: string;
  weightPercent: number;
  sessionNumber: number | null;
  sourceSnippet: string;
  sessionNote: string | null;
};

export type SyllabusProposalView = {
  id: string;
  sourceLabel: string;
  extractedCourseTitle: string;
  proposedTotalSessions: number | null;
  totalSessionsEvidence: string | null;
  notes: string | null;
  model: string;
  components: ProposedComponent[];
};

/**
 * The mandatory confirm gate for syllabus-extracted grade weights (PLAN.md §2b).
 *
 * ## Why this is a list of cards and not a table row per component
 *
 * The gate only works if the human checks each claim **against the document**. That
 * means the source snippet has to sit beside the number it justifies, at a glance,
 * on a phone. A table with a snippet column collapses to unreadable at 375px, and a
 * snippet hidden behind a disclosure is a snippet nobody opens — which turns the
 * whole step into the rubber-stamping PLAN.md §Grade Cockpit (c) warns against.
 * So: the extracted values large, the quote directly underneath, no interaction
 * required to see it.
 *
 * ## Why confirm is all-or-nothing
 *
 * Weights only mean anything as a set — they are meant to sum. Confirming three of
 * five would produce a grade projection from numbers the user never agreed to, and
 * silently at that. Adjusting one weight is what the per-row editor is for, once
 * these rows are real.
 */
export function SyllabusProposal({
  proposal,
  courseId,
}: {
  proposal: SyllabusProposalView;
  courseId: string;
}) {
  const total = sumWeightPercent(proposal.components.map((component) => component.weightPercent));
  // A syllabus legitimately need not sum to 100 (extra credit, "best 3 of 4"), so this
  // is stated, never enforced — the same rule the manual weight total already follows.
  const sums = Math.abs(total - 100) < 0.01;

  return (
    <section
      aria-labelledby={`proposal-${proposal.id}`}
      className="rounded-lg border border-accent-border bg-accent-subtle"
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-accent-border border-b px-4 py-3">
        <div className="min-w-0">
          <h3
            id={`proposal-${proposal.id}`}
            className="flex flex-wrap items-center gap-2 font-medium text-foreground text-ui-lg"
          >
            Proposed from a syllabus
            <Badge variant="outline">Needs review</Badge>
          </h3>
          <p className="mt-1 max-w-prose text-muted-foreground text-ui-sm">
            {pluralize(proposal.components.length, "component")} extracted from{" "}
            <span className="font-mono text-mono-data">{proposal.sourceLabel}</span> by{" "}
            <span className="font-mono text-mono-data">{proposal.model}</span>. Nothing here counts
            towards your grade until you confirm it — check each weight against the quote beneath
            it.
          </p>
        </div>
      </header>

      {proposal.extractedCourseTitle ? <TitleClaim title={proposal.extractedCourseTitle} /> : null}

      {proposal.notes ? (
        <Callout icon={<Warning aria-hidden="true" className="mt-0.5 shrink-0" />}>
          {proposal.notes}
        </Callout>
      ) : null}

      <ul className="divide-y divide-accent-border">
        {proposal.components.map((component) => (
          <li key={component.id} className="px-4 py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="font-medium text-foreground text-ui-base">{component.title}</span>
              <span className="font-mono text-foreground text-ui-lg tabular-nums">
                {formatWeight(component.weightPercent)}%
              </span>
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-ui-sm">
              <span>{assessmentKindLabel(component.kind)}</span>
              {component.sessionNumber === null ? null : (
                <span className="font-mono text-mono-data">Session {component.sessionNumber}</span>
              )}
              {/* A range ("sessions 28/29") cannot fit session_number, so it lands here
                  rather than being silently collapsed to one endpoint. */}
              {component.sessionNote ? <span>{component.sessionNote}</span> : null}
            </div>

            <blockquote className="mt-2 flex gap-2 rounded-md border border-border bg-surface px-3 py-2 text-muted-foreground text-ui-sm">
              <Quotes aria-hidden="true" className="mt-0.5 shrink-0 opacity-60" />
              <span className="min-w-0 break-words">{component.sourceSnippet}</span>
            </blockquote>
          </li>
        ))}
      </ul>

      <footer className="space-y-3 border-accent-border border-t px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-ui-sm">
          <span className="text-muted-foreground">Extracted weights total</span>
          <span className="font-mono text-foreground tabular-nums">{formatWeight(total)}%</span>
        </div>
        {sums ? null : (
          <p className="text-muted-foreground text-ui-sm">
            These don’t add up to 100%. That is often correct — extra credit, “best 3 of 4”, a
            rounded lecturer — so it is worth a look, not a blocker.
          </p>
        )}

        {proposal.proposedTotalSessions === null ? null : (
          <div className="rounded-md border border-border bg-surface px-3 py-2 text-ui-sm">
            <p className="text-foreground">
              Also sets this course to{" "}
              <span className="font-mono tabular-nums">{proposal.proposedTotalSessions}</span>{" "}
              sessions, marked as syllabus-declared.
            </p>
            {proposal.totalSessionsEvidence ? (
              <p className="mt-1 text-muted-foreground">
                <span className="font-mono text-mono-data">{proposal.totalSessionsEvidence}</span>
              </p>
            ) : null}
          </div>
        )}

        <SyllabusProposalActions
          courseId={courseId}
          extractionId={proposal.id}
          confirmAction={confirmSyllabusExtraction}
          rejectAction={rejectSyllabusExtraction}
        />
      </footer>
    </section>
  );
}

/**
 * What the document called itself.
 *
 * Always shown, never only on mismatch. PLAN.md §5.1b's DISPROVEN block exists because
 * a syllabus→course guess that *looked* right was wrong, and the feed disproved it —
 * so the document's own title is evidence the person confirming should always see,
 * not a warning that fires on a string comparison this code is not qualified to make.
 */
function TitleClaim({ title }: { title: string }) {
  return (
    <p className="border-accent-border border-b px-4 py-2 text-muted-foreground text-ui-sm">
      The document calls itself <span className="text-foreground">“{title}”</span>. If that isn’t
      this course, discard it.
    </p>
  );
}

function Callout({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <p className="flex gap-2 border-accent-border border-b px-4 py-2 text-muted-foreground text-ui-sm">
      {icon}
      <span className="min-w-0">{children}</span>
    </p>
  );
}
