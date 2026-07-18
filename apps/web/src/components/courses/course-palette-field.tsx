"use client";

import { useEffect, useId, useState } from "react";
import { COURSE_COLOR_LABEL, COURSE_SWATCH_CLASS } from "@/components/courses/course-color";
import { COURSE_COLORS, DEFAULT_COURSE_COLOR } from "@/lib/courses/schemas";
import type { FormState } from "@/lib/forms/form-state";
import { cn } from "@/lib/utils";

/**
 * The course colour picker: eight swatches, one of them chosen.
 *
 * A radio group rather than a colour input, because the column is a **palette
 * key**, not a colour — the design tokens own the light/dark OKLCH pair for
 * each (see `course-color.ts`). A free hex field would let the user pick
 * something with no dark-mode counterpart and no relationship to the chart
 * palette that reuses these same eight hues.
 *
 * This is deliberately not a `FormField`: that wraps a single control, and a
 * radio group needs a `fieldset`/`legend` so the group's name is announced
 * before the options. It follows the same two rules that matter — it holds its
 * value in state so React 19's post-action form reset cannot wipe it, and it
 * re-seeds from `state.values`.
 *
 * The swatch IS the radio (`appearance-none` + a background, clipped to the
 * content box). That keeps `focus-ring` on the actually-focusable element
 * rather than hand-rolling a `peer-focus-visible` outline on a label, and lets
 * the checked state show as a ring in the *foreground* colour — a shape
 * difference, not a second colour cue, which is what SC 1.4.1 asks for.
 */
export function CoursePaletteField({
  name = "color",
  state,
  defaultValue = DEFAULT_COURSE_COLOR,
}: {
  name?: string;
  state: FormState;
  defaultValue?: string;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const error = state.fieldErrors?.[name];

  const echoed = state.values?.[name];
  const [value, setValue] = useState(echoed || defaultValue);

  useEffect(() => {
    if (echoed) setValue(echoed);
  }, [echoed]);

  return (
    <fieldset
      aria-describedby={error ? errorId : undefined}
      aria-invalid={error ? true : undefined}
    >
      <legend className="mb-2 font-medium text-foreground text-ui-base">Colour</legend>

      <div className="flex flex-wrap items-center gap-2">
        {COURSE_COLORS.map((color) => (
          <input
            key={color}
            type="radio"
            name={name}
            value={color}
            checked={value === color}
            onChange={() => setValue(color)}
            aria-label={COURSE_COLOR_LABEL[color]}
            className={cn(
              "focus-ring size-7 cursor-pointer appearance-none rounded-full border-2 border-transparent bg-clip-content p-[3px] transition-colors duration-fast ease-out-quart",
              "pointer-coarse:size-11",
              "checked:border-foreground",
              COURSE_SWATCH_CLASS[color],
            )}
          />
        ))}
      </div>

      <p className="mt-2 text-muted-foreground text-ui-sm">
        Reused as this course’s chip everywhere it appears.
      </p>

      {error ? (
        <p id={errorId} className="mt-1 text-destructive text-ui-sm">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
