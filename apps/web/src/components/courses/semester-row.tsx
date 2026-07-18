"use client";

import { PencilSimple } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { formatTermDate } from "@/components/courses/format";
import { SemesterFields } from "@/components/courses/semester-form";
import { Form, type FormAction } from "@/components/form/form";
import { FormStatus } from "@/components/form/form-status";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import type { FormState } from "@/lib/forms/form-state";

export type SemesterView = {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
  courseCount: number;
};

/**
 * One term: a read row that swaps into an edit form in place, matching the
 * assessment rows on the course page so the two behave the same way.
 */
export function SemesterRow({ semester, action }: { semester: SemesterView; action: FormAction }) {
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

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
        <TableCell className="py-1.5 font-medium text-foreground">{semester.name}</TableCell>
        <TableCell className="py-1.5 font-mono text-muted-foreground tabular-nums">
          {formatTermDate(semester.startsOn)} — {formatTermDate(semester.endsOn)}
        </TableCell>
        <TableCell className="py-1.5 text-right font-mono tabular-nums">
          {semester.courseCount}
        </TableCell>
        <TableCell className="py-1.5 text-right">
          <Button
            ref={editButton}
            variant="ghost"
            size="sm"
            onClick={() => setEditing(true)}
            aria-label={`Edit ${semester.name}`}
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
      <TableCell colSpan={4} className="p-3">
        <Form
          action={action}
          initialState={{
            status: "idle",
            values: {
              name: semester.name,
              startsOn: semester.startsOn,
              endsOn: semester.endsOn,
            },
          }}
        >
          {(state) => (
            <>
              <input type="hidden" name="semesterId" value={semester.id} />

              <SemesterFields state={state} />
              <FormStatus state={state} />
              <CollapseOnSuccess state={state} onSuccess={close} />

              <div className="flex flex-wrap items-center gap-2">
                <SubmitButton name="intent" value="save" size="sm" pendingLabel="Saving…">
                  Save
                </SubmitButton>
                <Button variant="ghost" size="sm" onClick={close}>
                  Cancel
                </Button>
                <DeleteSemester courseCount={semester.courseCount} />
              </div>
            </>
          )}
        </Form>
      </TableCell>
    </TableRow>
  );
}

/**
 * Deleting a term is safe in a way archiving a course is not:
 * `courses.semester_id` is `on delete set null`, so the courses survive and
 * simply stop belonging to a term. The button says so when there are any, so
 * the consequence is visible before the click rather than after it.
 */
function DeleteSemester({ courseCount }: { courseCount: number }) {
  return (
    <span className="ms-auto flex items-center gap-2">
      {courseCount > 0 ? (
        <span className="text-muted-foreground text-ui-sm">
          {courseCount === 1
            ? "1 course keeps its place."
            : `${courseCount} courses keep their place.`}
        </span>
      ) : null}
      {/* The row's own hidden `semesterId` is what this posts with — a second
          copy here would put two entries under one name, and `FormData.get`
          would silently return whichever came first in the document. */}
      <SubmitButton
        name="intent"
        value="delete"
        variant="destructive"
        size="sm"
        pendingLabel="Deleting…"
      >
        Delete
      </SubmitButton>
    </span>
  );
}

function CollapseOnSuccess({ state, onSuccess }: { state: FormState; onSuccess: () => void }) {
  const done = useRef(onSuccess);
  done.current = onSuccess;

  useEffect(() => {
    if (state.status === "success") done.current();
  }, [state.status]);

  return null;
}
