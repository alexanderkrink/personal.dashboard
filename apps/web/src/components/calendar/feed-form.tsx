"use client";

import { Plus } from "@phosphor-icons/react";
import { Form, type FormAction } from "@/components/form/form";
import { FormField } from "@/components/form/form-field";
import { FormStatus } from "@/components/form/form-status";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import type { FormState } from "@/lib/forms/form-state";

/**
 * The two fields of a feed.
 *
 * 🔒 The URL input is `type="password"` with `autoComplete="off"`. That is not
 * decoration: the string is a capability token — anyone holding it can read the
 * whole calendar, forever, with no login — so it gets the same treatment as a
 * password. Masking it stops it being read over a shoulder or captured in a
 * screen recording, and keeps it out of browser autofill suggestions where it
 * would resurface as plain text on unrelated forms.
 *
 * `existing` switches the field from required to optional, because on an edit
 * form it starts EMPTY and blank means "keep the one on file". Pre-filling it
 * would mean sending the secret to the browser and echoing it back through the
 * document, which is precisely what must not happen.
 */
function FeedFields({ state, existing = false }: { state: FormState; existing?: boolean }) {
  return (
    <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
      <FormField name="label" label="Name" state={state}>
        {(control) => <Input {...control} required autoComplete="off" placeholder="IE Agenda" />}
      </FormField>

      <FormField
        name="url"
        label="Subscription URL"
        state={state}
        labelAdornment={
          <span className="text-muted-foreground text-ui-sm">
            {existing ? "Leave blank to keep the current one" : "Treated as a secret"}
          </span>
        }
      >
        {(control) => (
          <Input
            {...control}
            type="password"
            required={!existing}
            autoComplete="off"
            spellCheck={false}
            placeholder={existing ? "••••••••" : "https://…"}
          />
        )}
      </FormField>
    </div>
  );
}

/**
 * Adds a feed.
 *
 * The copy says "read-only" because that is the single fact that decides
 * whether someone is willing to paste the link at all: this app never writes
 * back to the university's calendar.
 */
export function FeedCreateForm({ action }: { action: FormAction }) {
  return (
    <Form action={action}>
      {(state) => (
        <>
          <FeedFields state={state} />
          <p className="text-muted-foreground text-ui-sm">
            Find it in your university calendar under “Subscribe” or “Export”. The link is read-only
            — nothing is ever written back — but it works without a password, so it is stored and
            shown here the way a password would be.
          </p>
          <FormStatus state={state} />
          <div>
            <SubmitButton size="sm" pendingLabel="Adding…">
              <Plus aria-hidden="true" />
              Add feed
            </SubmitButton>
          </div>
        </>
      )}
    </Form>
  );
}

export { FeedFields };
