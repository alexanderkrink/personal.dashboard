import type { Icon } from "@phosphor-icons/react";
import { BookOpen, CalendarBlank, FileText, House } from "@phosphor-icons/react";

/**
 * The M1 sidebar route map — the single source of truth for nav labels ↔ routes.
 * PLAN.md's "Canonical route map" describes the *finished* product (Today,
 * Calendar, Notes, Practice, Planner, Coding, Analytics); this is the subset
 * that exists in M1, decided explicitly by Alexander. Later milestones extend
 * this list rather than inventing competing names elsewhere.
 *
 * `href` is a literal union rather than `string` so `typedRoutes` can prove
 * every destination exists at build time.
 */
export type NavHref = "/" | "/courses" | "/calendar" | "/documents";

export type NavItem = {
  readonly href: NavHref;
  readonly label: string;
  /** One terse line, used as the ⌘K hint and the nav tooltip on the icon rail. */
  readonly hint: string;
  readonly icon: Icon;
};

export const NAV_ITEMS: readonly NavItem[] = [
  {
    href: "/",
    label: "Dashboard",
    hint: "This week, at a glance",
    icon: House,
  },
  {
    href: "/courses",
    label: "Courses",
    hint: "Semesters, courses and assessments",
    icon: BookOpen,
  },
  {
    href: "/calendar",
    label: "Calendar",
    hint: "Classes and deadlines",
    icon: CalendarBlank,
  },
  {
    href: "/documents",
    label: "Documents",
    hint: "Lecture slides, readings and notes",
    icon: FileText,
  },
] as const;

/**
 * Nav highlighting: `/` matches only itself, every other entry also owns its
 * subtree, so `/courses/abc` keeps Courses lit.
 */
export function isNavItemActive(href: NavHref, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
