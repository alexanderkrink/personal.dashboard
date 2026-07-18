import { WarningCircle } from "@phosphor-icons/react/dist/ssr";
import { type WeightTotalVerdict, weightTotalDelta, weightTotalVerdict } from "@study/core";
import { formatWeight } from "@/components/courses/format";
import { cn } from "@/lib/utils";

/**
 * The running total of a course's assessment weights, as a hero number (PLAN
 * "Hero numbers": big mono tabular numeral, unit small in sans, delta
 * punctuated in a semantic colour).
 *
 * **It warns; it never blocks.** A real syllabus does not always add up to 100
 * — extra credit, "best 3 of 4", a lecturer who rounded — and the person
 * holding the syllabus knows more than this code does. So the write always goes
 * through and the number simply tells the truth about what is on file. This is
 * a deliberate product decision, not an oversight.
 *
 * Green is used only for the balanced case, which is a *done* status. The two
 * drift cases take amber: PLAN reserves green for done/status and forbids it as
 * a "low" tier on the heat ramp.
 */
const TONE: Record<WeightTotalVerdict, string> = {
  empty: "text-muted-foreground",
  balanced: "text-success",
  under: "text-warning",
  over: "text-warning",
};

export function WeightTotal({ total, count }: { total: number; count: number }) {
  const verdict = weightTotalVerdict(total, count);
  const delta = weightTotalDelta(total);

  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <p className="flex items-baseline gap-1">
        <span className={cn("font-mono text-num-hero tabular-nums", TONE[verdict])}>
          {formatWeight(total)}
        </span>
        <span className="text-muted-foreground text-ui-md">% of the grade accounted for</span>
      </p>

      {verdict === "under" || verdict === "over" ? (
        <p className={cn("flex items-center gap-1.5 text-ui-sm", TONE[verdict])}>
          <WarningCircle aria-hidden="true" weight="fill" className="size-4" />
          <span>
            <span className="font-mono tabular-nums">
              {delta > 0 ? "+" : "−"}
              {formatWeight(Math.abs(delta))}
            </span>{" "}
            against 100 —{" "}
            {verdict === "under"
              ? "a component may still be missing."
              : "something may be counted twice."}{" "}
            <span className="text-muted-foreground">Saved either way.</span>
          </span>
        </p>
      ) : null}
    </div>
  );
}
