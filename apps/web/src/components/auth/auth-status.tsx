import { cn } from "@/lib/utils";

export type AuthStatusTone = "error" | "success" | "info";

const TONE_CLASS: Record<AuthStatusTone, string> = {
  error: "text-destructive",
  success: "text-success",
  info: "text-muted-foreground",
};

/**
 * The status line under an auth form. Carries the dot motif in the tone colour
 * — the motif's default azure is overridden to `currentColor`, which globals.css
 * explicitly allows.
 *
 * Errors are announced assertively (`role="alert"`); confirmations and hints
 * are polite (`role="status"`), so a screen reader is not interrupted by
 * "check your inbox".
 */
export function AuthStatus({
  tone,
  children,
}: {
  tone: AuthStatusTone;
  children: React.ReactNode;
}) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={cn("flex items-start gap-2 text-ui-base", TONE_CLASS[tone])}
    >
      {/* `bg-current` wins over `.dot-motif`'s azure: the motif is declared in
          the components layer, and Tailwind emits utilities after it. */}
      <span aria-hidden="true" className="dot-motif mt-[0.4rem] bg-current" />
      <span>{children}</span>
    </p>
  );
}
