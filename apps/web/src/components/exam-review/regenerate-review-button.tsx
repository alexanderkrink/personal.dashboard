"use client";

import { ArrowsClockwise } from "@phosphor-icons/react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { requestExamReview } from "@/app/(app)/courses/[id]/reviews/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * PLAN §9's *Regenerate* button — confirm-with-cost-estimate, because a click spends real money.
 *
 * ## The cost estimate is stated BEFORE the call, not after
 *
 * §9 prices a regeneration at ~$0.50–1.50 on Opus, and the confirm dialog says so before
 * anything is enqueued. A student who opened the review to read it should not be one stray tap
 * away from an Opus bill.
 *
 * ## Two layers stop a double bill
 *
 * The dialog's confirm button disables the instant it is pressed (`pending`), and once a
 * request is accepted the trigger stays disabled for the rest of the page's life (`requested`)
 * — so neither a double-click nor a click-while-in-flight can fire the action twice from here.
 * The authoritative guard is server-side (`generate-review`'s concurrency + freshness skip);
 * this is the cheap first line, and it also keeps the UI honest about what it already asked for.
 *
 * ## Deferred/paused
 *
 * When the budget guard defers or `AI_MAX_TIER` has clamped Opus, the action returns a
 * `deferred` result and this surfaces it as a warning toast rather than pretending a review is
 * on its way.
 */
export function RegenerateReviewButton({
  courseId,
  label,
}: {
  courseId: string;
  /** Trigger label — "Regenerate" when a review exists, "Generate exam review" when none does. */
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [requested, setRequested] = useState(false);
  const [pending, startTransition] = useTransition();
  // A stable idempotency token for this button instance: a double-click that races the
  // in-flight disable reuses it, so `generate-review`'s `idempotency: event.data.requestId`
  // collapses the two sends to one Opus run. A legit later regeneration is a fresh mount → a
  // fresh token (and `requested` disables this instance after its first accepted request).
  const [requestId] = useState(() => crypto.randomUUID());

  function confirm() {
    startTransition(async () => {
      const result = await requestExamReview({ courseId, requestId });
      if (result.ok) {
        setRequested(true);
        setOpen(false);
        toast.success("Review requested — it’ll appear here in a minute or two. Refresh to check.");
        return;
      }
      if (result.deferred) {
        setOpen(false);
        toast.warning(result.message);
        return;
      }
      toast.error(result.message);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm" disabled={requested || pending}>
            <ArrowsClockwise aria-hidden />
            {requested ? "Requested" : label}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label}?</DialogTitle>
          <DialogDescription>
            This runs one Opus pass over every topic in the course and typically costs{" "}
            <strong>$0.50–1.50</strong>. It replaces nothing — the new review is added and becomes
            the current one.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={pending} />}>Cancel</DialogClose>
          <Button onClick={confirm} disabled={pending || requested}>
            {pending ? "Requesting…" : "Regenerate (~$0.50–1.50)"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
