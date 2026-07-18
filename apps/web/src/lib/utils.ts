import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * `cn` = clsx + tailwind-merge, and tailwind-merge MUST be taught this project's
 * custom theme namespaces.
 *
 * Out of the box it only knows Tailwind's stock scales. Anything it does not
 * recognise in a `text-*` class falls through to the COLOR group, so
 * `cn("text-ui-base", "text-destructive")` used to resolve as two colours in
 * conflict and silently dropped the size — every component that set a type token
 * and a colour token together rendered at the browser default of 16px instead of
 * the 13px `ui-base` the design system asked for. The same blind spot hits
 * `duration-*`, `ease-*` and `rounded-*`, where the custom values instead fail to
 * conflict with each other at all and both survive into the DOM.
 *
 * Every entry below mirrors a real declaration in `app/globals.css`. Adding a
 * type step, easing, radius or duration there means adding it here too; the
 * tests in `utils.test.ts` are what keep the two in step.
 */

/** `--text-*` in the `@theme inline` block (PLAN.md "Typography" type scale). */
const TEXT_SCALE = [
  "ui-xs",
  "ui-sm",
  "ui-base",
  "ui-md",
  "ui-lg",
  "ui-xl",
  "read-body",
  "read-h3",
  "read-h2",
  "read-h1",
  "read-cap",
  "mono-data",
  "mono-code",
  "num-hero",
  "num-hero-lg",
  "num-hero-xl",
  "wordmark",
] as const;

/** `--ease-*` in `@theme inline`. No bounce/spring/elastic, by design. */
const EASINGS = ["out-quart", "out-expo"] as const;

/** `--font-*` in `@theme inline`. */
const FONT_FAMILIES = ["heading", "sans", "serif", "mono"] as const;

/**
 * `--radius-reading`, the soft 10px radius of the reading register. The rest of
 * the radius scale (`sm`/`md`/`lg`/`xl`/…) is stock t-shirt sizing that
 * tailwind-merge already resolves.
 */
const RADII = ["reading"] as const;

/**
 * The named duration utilities. These are NOT a theme namespace — Tailwind v4
 * has no `--duration-*` namespace, so globals.css declares them at `:root` and
 * emits real utilities via `@utility`. tailwind-merge therefore has to learn
 * them as an extra class-group member rather than as theme values.
 */
const DURATIONS = ["instant", "fast", "base", "moderate", "slow"] as const;

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: [...TEXT_SCALE],
      ease: [...EASINGS],
      font: [...FONT_FAMILIES],
      radius: [...RADII],
    },
    classGroups: {
      duration: [{ duration: [...DURATIONS] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
