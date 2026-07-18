"use client";

import { Archive, ArrowCounterClockwise } from "@phosphor-icons/react";
import { Form, type FormAction } from "@/components/form/form";
import { FormStatus } from "@/components/form/form-status";
import { SubmitButton } from "@/components/submit-button";

/**
 * Archive or restore, depending on which side of the switch the course is on.
 *
 * There is no delete. A course is the row that documents, topics, cards,
 * calendar items and study events all reference, so removing it would take a
 * semester of history with it — `archived` moves it out of the list and keeps
 * every one of those intact.
 */
export function CourseArchiveForm({
  courseId,
  archived,
  action,
}: {
  courseId: string;
  archived: boolean;
  action: FormAction;
}) {
  return (
    <Form action={action} className="gap-2">
      {(state) => (
        <>
          <input type="hidden" name="courseId" value={courseId} />
          <SubmitButton
            name="intent"
            value={archived ? "restore" : "archive"}
            variant={archived ? "outline" : "ghost"}
            size="sm"
            pendingLabel="Working…"
          >
            {archived ? (
              <>
                <ArrowCounterClockwise aria-hidden="true" />
                Restore
              </>
            ) : (
              <>
                <Archive aria-hidden="true" />
                Archive
              </>
            )}
          </SubmitButton>
          <FormStatus state={state} className="text-ui-sm" />
        </>
      )}
    </Form>
  );
}
