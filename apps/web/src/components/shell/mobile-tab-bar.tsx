"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FOCUS_RING } from "@/components/shell/focus-ring";
import { isNavItemActive, NAV_ITEMS } from "@/components/shell/nav-items";
import { cn } from "@/lib/utils";

/**
 * Bottom-tab navigation below `md` (PLAN.md "Navigation" / "Mobile / PWA").
 * The sidebar's counterpart, not a duplicate: only one of the two is ever in
 * the accessibility tree at a given viewport, so both can be labelled Primary
 * without colliding.
 */
export function MobileTabBar() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-sidebar-border border-t bg-sidebar pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="flex items-stretch justify-around">
        {NAV_ITEMS.map((item) => {
          const active = isNavItemActive(item.href, pathname);
          const Icon = item.icon;
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                data-active={active ? "true" : undefined}
                className={cn(
                  // 44px floor comes from min-h-14 (56px) — comfortably clear.
                  "flex min-h-14 min-w-11 flex-col items-center justify-center gap-1 rounded-md px-1 py-2 text-ui-xs transition-colors duration-fast ease-out-quart",
                  FOCUS_RING,
                  active ? "font-medium text-foreground" : "font-normal text-muted-foreground",
                )}
              >
                <Icon
                  aria-hidden="true"
                  weight={active ? "fill" : "regular"}
                  className="size-5 shrink-0"
                />
                <span className="truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
