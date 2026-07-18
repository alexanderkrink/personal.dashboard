"use client";

import { MagnifyingGlass } from "@phosphor-icons/react";
import { usePathname } from "next/navigation";
import { FOCUS_RING } from "@/components/shell/focus-ring";
import { isNavItemActive, NAV_ITEMS } from "@/components/shell/nav-items";
import { Wordmark } from "@/components/shell/wordmark";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

function useSectionTitle(): string {
  const pathname = usePathname();
  return NAV_ITEMS.find((item) => isNavItemActive(item.href, pathname))?.label ?? "Study Dashboard";
}

/**
 * The minimal top bar (PLAN.md "Navigation"): context title, ⌘K trigger, theme
 * toggle. The sync-status chip PLAN also lists is deliberately absent — there
 * are no calendar feeds to report on until the ICS sync lands, and a chip that
 * always says "ok" is a lie in waiting.
 */
export function TopBar({ onOpenCommandPalette }: { onOpenCommandPalette: () => void }) {
  const title = useSectionTitle();

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-border border-b bg-background/85 px-4 backdrop-blur-sm">
      {/* The wordmark lives in the sidebar on desktop; below `md` the sidebar is
          gone, so the top bar carries it. */}
      <Wordmark className="md:hidden" />
      <h1 className="hidden font-medium text-foreground text-ui-lg md:block">{title}</h1>

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onOpenCommandPalette}
          className={cn(
            "flex h-9 min-w-11 items-center gap-2 rounded-md border border-border bg-input/30 px-2.5 text-muted-foreground text-ui-base transition-colors duration-fast ease-out-quart hover:bg-muted hover:text-foreground",
            "pointer-coarse:h-11",
            FOCUS_RING,
          )}
        >
          <MagnifyingGlass aria-hidden="true" className="size-4 shrink-0" />
          <span className="hidden sm:inline">Jump to…</span>
          <kbd className="hidden rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-ui-xs sm:inline">
            ⌘K
          </kbd>
          <span className="sr-only">Open the command palette</span>
        </button>
        <ThemeToggle />
      </div>
    </header>
  );
}
