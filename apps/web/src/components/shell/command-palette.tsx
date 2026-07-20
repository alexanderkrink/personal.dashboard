"use client";

import { CalendarPlus, Desktop, Moon, Sun } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useCallback } from "react";
import { NAV_ITEMS, type NavHref } from "@/components/shell/nav-items";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";

/**
 * The global ⌘K palette (PLAN.md "Navigation").
 *
 * PLAN groups the palette as Actions / Search / Navigate. **Actions** opened
 * with CAL-3's natural-language quick-add — the palette is how "add to
 * calendar" is reachable from anywhere, per §6's "⌘K from anywhere". Semantic
 * Search still lands with the document pipeline.
 *
 * Actions come FIRST: someone who opens the palette to do something should not
 * scan past five navigation rows to find the verb.
 */
export function CommandPalette({
  open,
  onOpenChange,
  onQuickAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens the quick-add dialog. The palette closes itself first — one modal at a time. */
  onQuickAdd: () => void;
}) {
  const router = useRouter();
  const { setTheme } = useTheme();

  const go = useCallback(
    (href: NavHref) => {
      onOpenChange(false);
      router.push(href);
    },
    [onOpenChange, router],
  );

  const applyTheme = useCallback(
    (theme: "light" | "dark" | "system") => {
      onOpenChange(false);
      setTheme(theme);
    },
    [onOpenChange, setTheme],
  );

  const quickAdd = useCallback(() => {
    onOpenChange(false);
    onQuickAdd();
  }, [onOpenChange, onQuickAdd]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Add to your calendar, jump to a section or change the appearance."
    >
      <CommandInput placeholder="Type a command or jump to…" />
      <CommandList>
        <CommandEmpty className="text-muted-foreground text-ui-base">
          Nothing matches that yet. Search across your documents arrives with the pipeline.
        </CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem
            value="Add to calendar quick add deadline task natural language"
            onSelect={quickAdd}
          >
            <CalendarPlus aria-hidden="true" />
            <span>Add to calendar…</span>
            <span className="ml-auto text-muted-foreground text-ui-xs">
              “essay due friday 23:59”
            </span>
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Navigate">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <CommandItem
                key={item.href}
                value={`${item.label} ${item.hint}`}
                onSelect={() => go(item.href)}
              >
                <Icon aria-hidden="true" />
                <span>{item.label}</span>
                <span className="ml-auto text-muted-foreground text-ui-xs">{item.hint}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Appearance">
          <CommandItem value="Theme light" onSelect={() => applyTheme("light")}>
            <Sun aria-hidden="true" />
            <span>Light theme</span>
          </CommandItem>
          <CommandItem value="Theme dark" onSelect={() => applyTheme("dark")}>
            <Moon aria-hidden="true" />
            <span>Dark theme</span>
          </CommandItem>
          <CommandItem value="Theme system" onSelect={() => applyTheme("system")}>
            <Desktop aria-hidden="true" />
            <span>Match system</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
