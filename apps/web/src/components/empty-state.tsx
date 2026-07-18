// TYPE-ONLY, and only available from the root barrel — `dist/ssr` re-exports the
// components but not `lib/types`. `import type` is erased before emit, so this
// pulls no client barrel into a Server Component; PLAN's `dist/ssr` rule governs
// *value* imports, which the callers of this component honour.
import type { Icon } from "@phosphor-icons/react";
import Link from "next/link";
import { FOCUS_RING } from "@/components/shell/focus-ring";
import { cn } from "@/lib/utils";

export type EmptyStatePoint = {
  /** The lead-in, set in mono — this is the label you'll see again once it ships. */
  term: string;
  detail: string;
};

/**
 * A *teaching* empty state (PLAN.md "States & voice"): it names what will live
 * here, shows the shape of it, and hands over one next action. Never a bare
 * "Nothing here." Voice: precise, with the warmth reserved for exactly these
 * moments.
 *
 * A Server Component. `icon` is rendered in `duotone` — PLAN reserves that
 * weight for feature and empty-state moments — so callers must pass it from
 * `@phosphor-icons/react/dist/ssr`.
 */
export function EmptyState({
  icon: Glyph,
  headline,
  body,
  points,
  note,
  cta,
}: {
  icon: Icon;
  headline: string;
  body: string;
  points?: readonly EmptyStatePoint[];
  /** The honest status line: what has to happen before this surface fills up. */
  note?: string;
  /**
   * A literal union rather than `string` so `typedRoutes` proves the
   * destination exists at build time. Extend it when a new empty state needs a
   * new target — the compile error is the point.
   */
  cta?: {
    href: "/" | "/courses" | "/calendar" | "/documents" | "/courses/new" | "/courses/semesters";
    label: string;
  };
}) {
  return (
    <section className="rounded-lg border border-border bg-surface p-6 md:p-8">
      <Glyph aria-hidden="true" weight="duotone" className="size-6 text-accent" />
      <h3 className="mt-4 font-medium text-foreground text-ui-lg">{headline}</h3>
      <p className="mt-1.5 max-w-prose text-muted-foreground text-ui-md">{body}</p>

      {points && points.length > 0 ? (
        <ul className="mt-5 max-w-prose space-y-2.5 border-border border-t pt-5">
          {points.map((point) => (
            <li key={point.term} className="flex items-start gap-2.5 text-ui-base">
              <span aria-hidden="true" className="dot-motif mt-[0.45rem]" />
              <span className="text-muted-foreground">
                <span className="font-medium font-mono text-foreground">{point.term}</span>
                {" — "}
                {point.detail}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {note ? <p className="mt-5 max-w-prose text-muted-foreground text-ui-sm">{note}</p> : null}

      {cta ? (
        <Link
          href={cta.href}
          className={cn(
            "mt-5 inline-flex h-8 min-h-8 items-center gap-1.5 rounded-md bg-primary px-3 font-medium text-primary-foreground text-ui-base transition-colors duration-fast ease-out-quart hover:bg-accent-hover",
            "pointer-coarse:h-11",
            FOCUS_RING,
          )}
        >
          {cta.label}
        </Link>
      ) : null}
    </section>
  );
}
