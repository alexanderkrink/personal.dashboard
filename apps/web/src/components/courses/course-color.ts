import type { CourseColor } from "@/lib/courses/schemas";

/**
 * Palette key → Tailwind class.
 *
 * Written out rather than interpolated (`bg-course-${key}`) because Tailwind
 * scans source text: a constructed class name is a class name that never gets
 * generated, and the swatch silently renders transparent. The tokens behind
 * these resolve to a different OKLCH per theme (globals.css `--course-*`),
 * which is the whole reason the database stores a key and not a hex.
 */
export const COURSE_SWATCH_CLASS: Record<CourseColor, string> = {
  indigo: "bg-course-indigo",
  violet: "bg-course-violet",
  pink: "bg-course-pink",
  gold: "bg-course-gold",
  green: "bg-course-green",
  teal: "bg-course-teal",
  cyan: "bg-course-cyan",
  rust: "bg-course-rust",
};

/** Sentence-case names, for the radio labels and the `aria-label` on a dot. */
export const COURSE_COLOR_LABEL: Record<CourseColor, string> = {
  indigo: "Indigo",
  violet: "Violet",
  pink: "Pink",
  gold: "Gold",
  green: "Green",
  teal: "Teal",
  cyan: "Cyan",
  rust: "Rust",
};

/**
 * Narrows the `text` the database hands back. The column has a check
 * constraint, so this only ever falls through if the constraint is changed
 * without this map — in which case a default beats a transparent dot.
 */
export function asCourseColor(value: string): CourseColor {
  return value in COURSE_SWATCH_CLASS ? (value as CourseColor) : "indigo";
}
