"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { CommandPalette } from "@/components/shell/command-palette";
import { FOCUS_RING } from "@/components/shell/focus-ring";
import { MobileTabBar } from "@/components/shell/mobile-tab-bar";
import { TopBar } from "@/components/shell/top-bar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const COLLAPSE_STORAGE_KEY = "study-dashboard:sidebar-collapsed";

/** PLAN.md "Navigation": 240px expanded / 56px icon-rail. */
const SIDEBAR_WIDTH_EXPANDED = "15rem";
const SIDEBAR_WIDTH_RAIL = "3.5rem";

/**
 * The application shell: sidebar (or bottom tabs), top bar, ⌘K palette.
 *
 * Client, because it owns the collapse and palette state; `children` arrive
 * already rendered from the Server Component layout, so nothing about the page
 * payload becomes client-side by living inside it.
 */
export function AppShell({ email, children }: { email: string | null; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [ready, setReady] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    setCollapsed(window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === "true");
    setReady(true);
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((previous) => {
      const next = !previous;
      window.localStorage.setItem(COLLAPSE_STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  // ⌘K / Ctrl-K toggles the palette from anywhere. `key` is compared
  // case-insensitively because ⌘ + Shift + K still reports "K".
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setPaletteOpen((open) => !open);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const openPalette = useCallback(() => setPaletteOpen(true), []);

  return (
    <TooltipProvider>
      <div
        className="min-h-svh bg-background"
        style={
          {
            "--sidebar-width": collapsed ? SIDEBAR_WIDTH_RAIL : SIDEBAR_WIDTH_EXPANDED,
          } as React.CSSProperties
        }
      >
        <a
          href="#main-content"
          className={cn(
            "sr-only rounded-md bg-popover px-3 py-2 text-popover-foreground text-ui-base shadow-lg focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50",
            FOCUS_RING,
          )}
        >
          Skip to content
        </a>

        <AppSidebar collapsed={collapsed} onToggle={toggleCollapsed} email={email} ready={ready} />

        <div
          className={cn(
            "flex min-h-svh flex-col md:pl-(--sidebar-width)",
            ready && "transition-[padding] duration-base ease-out-quart",
          )}
        >
          <TopBar onOpenCommandPalette={openPalette} />
          {/* pb-20 clears the mobile tab bar; it collapses back on md+. */}
          <main id="main-content" className="flex-1 px-4 pt-5 pb-20 md:px-6 md:pb-8">
            {children}
          </main>
        </div>

        <MobileTabBar />
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        <Toaster />
      </div>
    </TooltipProvider>
  );
}
