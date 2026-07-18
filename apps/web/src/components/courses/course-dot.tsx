import { cn } from "@/lib/utils";
import { asCourseColor, COURSE_COLOR_LABEL, COURSE_SWATCH_CLASS } from "./course-color";

/**
 * The course's colour, as the dot motif (PLAN "Wordmark, motif & favicon": the
 * dot is reused system-wide, including as a course marker).
 *
 * Decorative by default — the course title is always right next to it, and a
 * screen reader announcing "Indigo" before every course name is noise. Pass
 * `label` only where the dot is the *only* thing carrying the colour.
 *
 * No `"use client"`: this renders in Server Components and inside client ones.
 */
export function CourseDot({
  color,
  label = false,
  className,
}: {
  color: string;
  label?: boolean;
  className?: string;
}) {
  const key = asCourseColor(color);

  return (
    <span
      aria-hidden={label ? undefined : "true"}
      {...(label ? { role: "img", "aria-label": COURSE_COLOR_LABEL[key] } : {})}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        COURSE_SWATCH_CLASS[key],
        className,
      )}
    />
  );
}
