"use client";

import { Sparkle } from "@phosphor-icons/react";
import { Form, type FormAction } from "@/components/form/form";
import { FormField } from "@/components/form/form-field";
import { FormStatus } from "@/components/form/form-status";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/**
 * Paste a syllabus, get proposed graded components.
 *
 * **Text, not a file upload.** Upload, storage and PDF/DOCX conversion are item 5
 * (Wave 4). This is the interim path and it is not a bad one — "select all, paste" is
 * ten seconds and needs no pipeline behind it.
 *
 * The copy leads with what happens *after*, not with what the AI does. Someone about to
 * hand grade weights to a model needs to know before they press the button that nothing
 * lands active — that is what makes the confirm gate read as a safeguard rather than as
 * an extra chore imposed on them afterwards.
 *
 * Both hints go through `describedBy` rather than sitting loose above the control. The
 * "paste the whole document" one in particular is not decoration: PLAN.md §5.1b records
 * that a header-only read produced the exact opposite of the truth, so it is the single
 * most useful thing this form can tell someone — including someone using a screen
 * reader, who would never see a floating paragraph.
 */
export function SyllabusExtractForm({
  courseId,
  action,
}: {
  courseId: string;
  action: FormAction;
}) {
  return (
    <Form action={action}>
      {(state) => (
        <>
          <input type="hidden" name="courseId" value={courseId} />

          <FormField
            name="sourceLabel"
            label="Document name"
            state={state}
            describedBy="syllabus-label-hint"
          >
            {(control) => (
              <>
                <Input
                  {...control}
                  required
                  maxLength={200}
                  placeholder="marketing-fundamentals.pdf"
                />
                <p id="syllabus-label-hint" className="text-muted-foreground text-ui-sm">
                  How you’ll recognise this later — the file name is fine.
                </p>
              </>
            )}
          </FormField>

          <FormField
            name="documentText"
            label="Syllabus text"
            state={state}
            describedBy="syllabus-text-hint"
          >
            {(control) => (
              <>
                <Textarea
                  {...control}
                  required
                  rows={8}
                  className="font-mono text-mono-data"
                  placeholder="Paste the full text of the syllabus here…"
                />
                <p id="syllabus-text-hint" className="text-muted-foreground text-ui-sm">
                  Paste the whole document, not just the header — the evaluation table is usually
                  about two thirds of the way down.
                </p>
              </>
            )}
          </FormField>

          <FormStatus state={state} />

          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <SubmitButton pendingLabel="Reading the syllabus…">
              <Sparkle aria-hidden="true" />
              Extract components
            </SubmitButton>
            <p className="text-muted-foreground text-ui-sm">
              Nothing counts towards your grade until you review and confirm it.
            </p>
          </div>
        </>
      )}
    </Form>
  );
}
