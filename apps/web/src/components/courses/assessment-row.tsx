"use client";

import { PencilSimple } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { AssessmentFields } from "@/components/courses/assessment-fields";
import { formatWeight } from "@/components/courses/format";
import { Form, type FormAction } from "@/components/form/form";
import { FormStatus } from "@/components/form/form-status";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import { assessmentKindLabel } from "@/lib/courses/schemas";
import type { FormState } from "@/lib/forms/form-state";

export type AssessmentView = {
  id: string;
  title: string;
  kind: string;
  weightPercent: number;
  dueHint: string | null;
};

/**
 * One graded component: a read row that swaps into an edit form in place.
 *
 * Editing expands the row rather than navigating, because entering a syllabus
 * is one sitting and a round-trip per component would be hostile. The expanded
 * form carries both submitters — Save and Delete — via the `intent` convention,
 * which also means deleting a component requires opening its row first. That is
 * the confirmation step; a modal would cost more than it protects for something
 * this cheap to retype.
 */
export function AssessmentRow({
  assessment,
  courseId,
  action,
}: {
  assessment: AssessmentView;
  courseId: string;
  action: FormAction;
}) {
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  // Collapsing the editor destroys whatever had focus, which would dump the
  // user on `<body>` and lose their place in the table. Send them back to the
  // control they opened it with.
  useEffect(() => {
    if (editing || !restoreFocus.current) return;
    restoreFocus.current = false;
    editButton.current?.focus();
  }, [editing]);

  function close() {
    restoreFocus.current = true;
    setEditing(false);
  }

  if (!editing) {
    return (
      <TableRow className="hover:bg-accent-subtle">
        <TableCell className="py-1.5 font-medium text-foreground">{assessment.title}</TableCell>
        <TableCell className="py-1.5 text-muted-foreground">
          {assessmentKindLabel(assessment.kind)}
        </TableCell>
        <TableCell className="py-1.5 text-right font-mono tabular-nums">
          {formatWeight(assessment.weightPercent)}
          <span className="text-muted-foreground">%</span>
        </TableCell>
        <TableCell className="py-1.5 text-muted-foreground">{assessment.dueHint ?? "—"}</TableCell>
        <TableCell className="py-1.5 text-right">
          <Button
            ref={editButton}
            variant="ghost"
            size="sm"
            onClick={() => setEditing(true)}
            aria-label={`Edit ${assessment.title}`}
          >
            <PencilSimple aria-hidden="true" />
            Edit
          </Button>
        </TableCell>
      </TableRow>
    );
  }

  return (
    <TableRow className="bg-accent-subtle">
      {/* The editor spans the row: four controls will not fit the read columns,
          and forcing them to would size every column to its widest input even
          when nothing is being edited. */}
      <TableCell colSpan={5} className="p-3">
        <Form
          action={action}
          initialState={{
            status: "idle",
            values: {
              title: assessment.title,
              kind: assessment.kind,
              weightPercent: String(assessment.weightPercent),
              dueHint: assessment.dueHint ?? "",
            },
          }}
        >
          {(state) => (
            <>
              <input type="hidden" name="assessmentId" value={assessment.id} />
              <input type="hidden" name="courseId" value={courseId} />

              <AssessmentFields state={state} />
              <FormStatus state={state} />
              <CollapseOnSuccess state={state} onSuccess={close} />

              <div className="flex flex-wrap items-center gap-2">
                <SubmitButton name="intent" value="save" size="sm" pendingLabel="Saving…">
                  Save
                </SubmitButton>
                <Button variant="ghost" size="sm" onClick={close}>
                  Cancel
                </Button>
                <SubmitButton
                  name="intent"
                  value="delete"
                  variant="destructive"
                  size="sm"
                  className="ms-auto"
                  pendingLabel="Deleting…"
                >
                  Delete
                </SubmitButton>
              </div>
            </>
          )}
        </Form>
      </TableCell>
    </TableRow>
  );
}

/**
 * Closes the editor once a save lands.
 *
 * Only on `success`, which is what a save returns. A delete returns `info` and
 * deliberately leaves the row open showing "Deleted." until the revalidated
 * page removes it — collapsing first would replace the confirmation with a row
 * that is about to vanish anyway.
 *
 * It renders nothing; it exists so the effect can live inside `Form`'s render
 * prop, where the state actually is, without the parent calling `setState`
 * during its own render.
 */
function CollapseOnSuccess({ state, onSuccess }: { state: FormState; onSuccess: () => void }) {
  const done = useRef(onSuccess);
  done.current = onSuccess;

  useEffect(() => {
    if (state.status === "success") done.current();
  }, [state.status]);

  return null;
}
