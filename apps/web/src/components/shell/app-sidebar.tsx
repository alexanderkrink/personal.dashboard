"use client";

import { SidebarSimple, SignOut } from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "@/app/auth/actions";
import { FOCUS_RING_SIDEBAR } from "@/components/shell/focus-ring";
import { isNavItemActive, NAV_ITEMS, type NavItem } from "@/components/shell/nav-items";
import { Wordmark } from "@/components/shell/wordmark";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

function SidebarNavLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const pathname = usePathname();
  const active = isNavItemActive(item.href, pathname);
  const Icon = item.icon;

  const link = (
    <Link
      href={item.href}
      // `aria-current` is the accessible half of "active"; the tint, the fill
      // weight and the dot are the visual half. Never colour alone.
      aria-current={active ? "page" : undefined}
      data-active={active ? "true" : undefined}
      className={cn(
        "relative flex h-9 items-center rounded-md text-ui-base transition-colors duration-fast ease-out-quart",
        // 44px minimum touch target on coarse pointers (PLAN a11y); the
        // compact 36px row is for mice only.
        "pointer-coarse:h-11",
        collapsed ? "justify-center px-0" : "gap-2.5 px-2.5",
        FOCUS_RING_SIDEBAR,
        active
          ? "bg-accent-subtle font-medium text-foreground"
          : "font-normal text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {/* fill = active (PLAN.md "Iconography"); 20px is the nav size. */}
      <Icon aria-hidden="true" weight={active ? "fill" : "regular"} className="size-5 shrink-0" />
      {collapsed ? (
        <span className="sr-only">{item.label}</span>
      ) : (
        <span className="truncate">{item.label}</span>
      )}
      {active ? (
        <span
          aria-hidden="true"
          className={cn("dot-motif", collapsed ? "absolute right-1.5" : "ml-auto")}
        />
      ) : null}
    </Link>
  );

  // On the icon rail the label has nowhere to render, so it becomes a tooltip.
  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger render={link} />
      <TooltipContent side="right" className="flex-col items-start gap-0.5">
        <span className="font-medium">{item.label}</span>
        <span className="text-background/70">{item.hint}</span>
      </TooltipContent>
    </Tooltip>
  );
}

export function AppSidebar({
  collapsed,
  onToggle,
  email,
  ready,
}: {
  collapsed: boolean;
  onToggle: () => void;
  email: string | null;
  /**
   * False until the persisted collapse state has been read from localStorage.
   * The width transition is suppressed until then, otherwise a user who left
   * the rail collapsed watches it animate shut on every page load — motion
   * that conveys no state change, which the motion spec rules out.
   */
  ready: boolean;
}) {
  return (
    // Hidden below `md`: small screens get the bottom tab bar instead
    // (PLAN.md "Navigation" — responsive behaviour is structural, not fluid).
    <nav
      aria-label="Primary"
      data-collapsed={collapsed ? "true" : undefined}
      className={cn(
        "fixed inset-y-0 left-0 z-40 hidden w-(--sidebar-width) flex-col border-sidebar-border border-r bg-sidebar md:flex",
        ready && "transition-[width] duration-base ease-out-quart",
      )}
    >
      <div
        className={cn(
          "flex h-14 shrink-0 items-center border-sidebar-border border-b",
          collapsed ? "justify-center px-0" : "justify-between px-3",
        )}
      >
        {collapsed ? (
          <span aria-hidden="true" className="dot-motif size-1.5" />
        ) : (
          <Link href="/" className={cn("rounded-md", FOCUS_RING_SIDEBAR)}>
            <Wordmark />
          </Link>
        )}
      </div>

      <ul className={cn("flex flex-1 flex-col gap-0.5 py-3", collapsed ? "px-2" : "px-2")}>
        {NAV_ITEMS.map((item) => (
          <li key={item.href}>
            <SidebarNavLink item={item} collapsed={collapsed} />
          </li>
        ))}
      </ul>

      <div className={cn("border-sidebar-border border-t p-2", collapsed && "px-2")}>
        {collapsed ? null : (
          <p
            className="truncate px-2.5 pb-1.5 text-muted-foreground text-ui-xs"
            title={email ?? ""}
          >
            {email ?? "Not signed in"}
          </p>
        )}
        <form action={signOut}>
          <button
            type="submit"
            className={cn(
              "flex h-9 w-full items-center rounded-md text-muted-foreground text-ui-base transition-colors duration-fast ease-out-quart hover:bg-muted hover:text-foreground",
              "pointer-coarse:h-11",
              collapsed ? "justify-center px-0" : "gap-2.5 px-2.5",
              FOCUS_RING_SIDEBAR,
            )}
          >
            <SignOut aria-hidden="true" className="size-5 shrink-0" />
            {collapsed ? <span className="sr-only">Sign out</span> : <span>Sign out</span>}
          </button>
        </form>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className={cn(
            "mt-0.5 flex h-9 w-full items-center rounded-md text-muted-foreground text-ui-base transition-colors duration-fast ease-out-quart hover:bg-muted hover:text-foreground",
            "pointer-coarse:h-11",
            collapsed ? "justify-center px-0" : "gap-2.5 px-2.5",
            FOCUS_RING_SIDEBAR,
          )}
        >
          <SidebarSimple aria-hidden="true" className="size-5 shrink-0" />
          {collapsed ? (
            <span className="sr-only">Expand sidebar</span>
          ) : (
            <span>Collapse sidebar</span>
          )}
        </button>
      </div>
    </nav>
  );
}
