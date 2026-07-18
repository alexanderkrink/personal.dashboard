/**
 * The one focus treatment (PLAN.md "Elevation & surfaces" / "Mobile / PWA &
 * accessibility"): 2px bright-azure ring + 2px offset in the surface colour,
 * always visible. Every focusable in the app composes this; nothing may replace
 * it with `outline-none` alone.
 *
 * The implementation is the `focus-ring` utility in `globals.css`, which uses a
 * real `outline` so the 2px offset is transparent and therefore picks up
 * whichever surface the control is actually standing on. That is also why the
 * sidebar no longer needs a variant of its own: `FOCUS_RING_SIDEBAR` existed
 * only to re-declare the ring-offset colour against `--sidebar`, and a
 * transparent offset is correct on every surface by construction.
 */
export const FOCUS_RING = "focus-ring";
