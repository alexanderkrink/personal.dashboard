/**
 * The one focus treatment (PLAN.md "Elevation & surfaces" / "Mobile / PWA &
 * accessibility"): 2px bright-azure ring + 2px offset in the surface colour,
 * always visible. Every focusable in the shell composes this; nothing may
 * replace it with `outline-none` alone.
 */
export const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** Same ring, offset against the sidebar surface rather than the app canvas. */
export const FOCUS_RING_SIDEBAR =
  "outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar";
