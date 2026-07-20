"use client";

import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { setExamWeightOverride } from "@/app/(app)/courses/[id]/topics/[slug]/actions";
import { Button } from "@/components/ui/button";

/**
 * PLAN §9's exam-weight override — *"a slider on each topic page, which wins outright when
 * set"*.
 *
 * ## Why a native `<input type="range">` and not a Base UI slider
 *
 * There is no slider in `components/ui/`, and adding one to change a single 0–1 number
 * would buy nothing a native range input does not already give: it is keyboard-operable,
 * it announces its value, and it respects the platform's own accessibility affordances.
 * The styling that matters — the accent — comes from `accent-primary`, one utility.
 *
 * ## The two states are genuinely different and the UI says so
 *
 * `exam_weight` is computed and `exam_weight_override` wins outright when set. Those are
 * different facts about the topic, and a slider that showed one number would hide which one
 * is in force. So the computed value is always stated, the override is shown as a
 * deliberate act, and *Clear* is always available — otherwise setting the slider once would
 * permanently detach the topic from a weight that recomputes after every merge.
 */
export function ExamWeightSlider({
  topicId,
  courseId,
  slug,
  computed,
  override,
}: {
  topicId: string;
  courseId: string;
  slug: string;
  computed: number;
  override: number | null;
}) {
  const id = useId();
  const [value, setValue] = useState(override ?? computed);
  const [pending, startTransition] = useTransition();

  const dirty = override === null ? value !== computed : value !== override;

  function save(next: number | null) {
    startTransition(async () => {
      const result = await setExamWeightOverride({
        topicId,
        courseId,
        slug,
        weight: next,
      });
      if (result.ok) {
        if (next === null) setValue(computed);
        toast.success(result.message ?? "Saved.");
      } else {
        toast.error(result.message ?? "That didn’t save.");
      }
    });
  }

  return (
    <div className="space-y-2 font-sans">
      <div className="flex items-baseline justify-between gap-2">
        <label className="font-medium text-ui-base" htmlFor={id}>
          Exam weight
        </label>
        <span className="font-mono text-mono-data tabular-nums">{value.toFixed(2)}</span>
      </div>

      <input
        className="w-full accent-primary"
        disabled={pending}
        id={id}
        max={1}
        min={0}
        onChange={(event) => setValue(Number(event.target.value))}
        step={0.05}
        type="range"
        value={value}
      />

      <p className="text-muted-foreground text-ui-xs">
        {override === null
          ? `Computed from the material: ${computed.toFixed(2)}. Set this to override it.`
          : `Your override is in force. The computed value is ${computed.toFixed(2)}.`}
      </p>

      <div className="flex gap-2">
        <Button disabled={pending || !dirty} onClick={() => save(value)} size="sm">
          {pending ? "Saving…" : "Set override"}
        </Button>
        {override === null ? null : (
          <Button disabled={pending} onClick={() => save(null)} size="sm" variant="ghost">
            Clear override
          </Button>
        )}
      </div>
    </div>
  );
}
