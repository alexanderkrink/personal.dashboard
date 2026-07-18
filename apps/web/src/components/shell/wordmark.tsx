import { cn } from "@/lib/utils";

/**
 * `study●dashboard` — JetBrains Mono 500, tracking −0.01em, the dot in bright
 * `--accent` (PLAN.md "Wordmark, motif & favicon"). The dot is decorative:
 * `aria-hidden` keeps screen readers from announcing a bullet mid-word, and the
 * visually-hidden text supplies the real name.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn("font-medium font-mono text-wordmark text-foreground", className)}
      data-slot="wordmark"
    >
      <span aria-hidden="true">
        study<span className="px-px text-accent">●</span>dashboard
      </span>
      <span className="sr-only">Alex&apos;s Study Dashboard</span>
    </span>
  );
}
