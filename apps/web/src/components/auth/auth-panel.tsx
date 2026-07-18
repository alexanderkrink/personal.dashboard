import { Wordmark } from "@/components/shell/wordmark";

/**
 * The one layout for every auth surface: sign-in, sign-up, forgot-password,
 * update-password. Deliberately outside the `(app)` route group — no sidebar,
 * no top bar, no palette. A single raised card on the app canvas, wordmark
 * above it, in the cockpit register (PLAN.md "Identity & design").
 *
 * The wordmark is NOT a link here: every route it could point at is either
 * behind the gate or behind a session, so a click would only bounce.
 */
export function AuthPanel({
  title,
  lead,
  children,
  footer,
}: {
  title: string;
  lead?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center px-5 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Wordmark />
        </div>

        <div className="rounded-lg border border-border bg-surface p-6">
          <h1 className="font-semibold text-foreground text-ui-xl">{title}</h1>
          {lead ? <p className="mt-1.5 text-muted-foreground text-ui-md">{lead}</p> : null}
          <div className="mt-6">{children}</div>
        </div>

        {footer ? (
          <div className="mt-5 text-center text-muted-foreground text-ui-base">{footer}</div>
        ) : null}
      </div>
    </main>
  );
}
