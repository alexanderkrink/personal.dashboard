"use client";

import { useEffect, useState } from "react";
import { listQuickAddCourses } from "@/app/(app)/calendar/quick-add-parse";
import { NlQuickAdd } from "@/components/calendar/nl-quick-add";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * The ⌘K quick-add surface (§6: "one input box, ⌘K from anywhere").
 *
 * The calendar page hands `NlQuickAdd` its course list from the Server Component; this
 * dialog floats over every route and has no such parent, so it fetches the list itself
 * — once per open, so a course created since the last open is present, and nothing is
 * queried for users who never press ⌘K.
 *
 * Everything else — the parse, the confirm card, the §2b write gate — is `NlQuickAdd`,
 * unchanged. The dialog is a picture frame, deliberately: a second quick-add
 * implementation would be a second thing that could drift from the gate.
 */
export function QuickAddDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [courses, setCourses] = useState<readonly { id: string; title: string }[] | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listQuickAddCourses().then((list) => {
      if (!cancelled) setCourses(list);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add to calendar</DialogTitle>
          <DialogDescription>
            Type it in one line, or fill in the form. Nothing is saved until you add it.
          </DialogDescription>
        </DialogHeader>
        <NlQuickAdd courses={courses ?? []} />
      </DialogContent>
    </Dialog>
  );
}
