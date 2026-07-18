"use client";

import { Desktop, Moon, Sun } from "@phosphor-icons/react";
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
 * PLAN groups the palette as Actions / Search / Navigate. M1 ships **Navigate**
 * and **Appearance** only: semantic Search lands with the document pipeline
 * (Wave 3) and quick-add Actions with the deadline model — a group that returns
 * nothing is worse than a group that isn't there yet.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Jump to a section or change the appearance."
    >
      <CommandInput placeholder="Jump to…" />
      <CommandList>
        <CommandEmpty className="text-muted-foreground text-ui-base">
          Nothing matches that yet. Search across your documents arrives with the pipeline.
        </CommandEmpty>
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
