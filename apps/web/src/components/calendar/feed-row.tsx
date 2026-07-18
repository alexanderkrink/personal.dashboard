"use client";

import { ArrowsClockwise, PencilSimple } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { FeedFields } from "@/components/calendar/feed-form";
import { Form, type FormAction } from "@/components/form/form";
import { FormStatus } from "@/components/form/form-status";
import { SubmitButton } from "@/components/submit-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import type { FormState } from "@/lib/forms/form-state";

/**
 * What the server is allowed to send the browser about a feed.
 *
 * 🔒 **There is no `url` on this type, and that is the point.** The row is a
 * Client Component, so every field here is serialised into the RSC payload and
 * shipped to the browser. The stored URL embeds a capability token, so what
 * crosses this boundary is `maskedUrl` (origin only) and `fingerprint` (a
 * non-reversible hash) — enough to tell two feeds apart, and not enough to read
 * anyone's calendar.
 */
export type FeedView = {
  id: string;
  label: string;
  /** Origin only; the path and query are replaced wholesale. */
  maskedUrl: string;
  /** Short non-reversible id, so two feeds on one host are distinguishable. */
  fingerprint: string;
  active: boolean;
  lastSyncedAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  itemCount: number;
};

function relativeTime(iso: string | null): string {
  if (!iso) return "never synced";
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "synced just now";
  if (minutes < 60) return `synced ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `synced ${hours} h ago`;
  return `synced ${Math.round(hours / 24)} d ago`;
}

function StatusBadge({ feed }: { feed: FeedView }) {
  if (!feed.active) return <Badge variant="outline">Paused</Badge>;
  if (feed.lastSyncStatus === "error") return <Badge variant="destructive">Needs attention</Badge>;
  if (feed.lastSyncStatus === null) return <Badge variant="outline">Not synced yet</Badge>;
  return <Badge variant="secondary">Connected</Badge>;
}

/**
 * One feed: a read row that swaps into an edit form in place, matching the
 * semester and assessment rows so all three behave the same way.
 */
export function FeedRow({ feed, action }: { feed: FeedView; action: FormAction }) {
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
        {/*
          `break-all` and a max width, because the masked URL is one long
          unbreakable monospace token and a table cell sizes to its widest
          unbreakable content. Without them this single cell pushed the table's
          intrinsic width to 740px inside a 341px viewport, so on a phone every
          column after the first — status, last sync, and the Edit button —
          sat off-screen behind a horizontal swipe with no affordance for it.
          Measured in a real browser at 375px; none of typecheck, lint, test or
          build can see this.
        */}
        <TableCell className="py-1.5">
          {/*
            Three properties, and all three are load-bearing — this took a
            browser and a `getComputedStyle` to pin down:

            - `max-w-*` on this DIV, not on the `<td>`. In `table-layout: auto` a
              cell's max-width is advisory and the browser may ignore it to fit
              content. A block child obeys ordinary box rules.
            - `whitespace-normal`, because shadcn's `TableCell` ships
              `whitespace-nowrap`. That silently beats `break-all`: nowrap
              forbids wrapping outright, so the break opportunities never apply.
              The box measured a correct 192px the whole time while its text
              ran straight out of it.
            - `break-all`, because the masked URL is one unbroken token with no
              spaces for a normal wrap to use.

            Without all three the URL ran off a 375px screen and took the
            fingerprint with it. None of typecheck, lint, test or build can see
            any of this.
          */}
          <div className="max-w-[12rem] whitespace-normal sm:max-w-[28rem]">
            <span className="font-medium text-foreground">{feed.label}</span>
            <span className="block break-all font-mono text-muted-foreground text-ui-sm">
              {feed.maskedUrl}
              <span className="ms-2 opacity-70">#{feed.fingerprint}</span>
            </span>
            {/*
            Below `sm` this cell carries what the other three columns say,
            because those columns are hidden there. Collapsing to
            [details | Edit] is the layout a 375px screen can actually hold —
            five columns fit only behind a horizontal swipe with no affordance,
            which put the Edit button out of reach on a phone.
          */}
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-ui-sm sm:hidden">
              <StatusBadge feed={feed} />
              {relativeTime(feed.lastSyncedAt)} · {feed.itemCount} entries
            </span>
            {feed.lastSyncStatus === "error" && feed.lastSyncError ? (
              <span className="mt-1 block text-destructive text-ui-sm">{feed.lastSyncError}</span>
            ) : null}
          </div>
        </TableCell>
        <TableCell className="hidden py-1.5 sm:table-cell">
          <StatusBadge feed={feed} />
        </TableCell>
        <TableCell className="hidden py-1.5 text-muted-foreground text-ui-sm sm:table-cell">
          {relativeTime(feed.lastSyncedAt)}
        </TableCell>
        <TableCell className="hidden py-1.5 text-right font-mono tabular-nums sm:table-cell">
          {feed.itemCount}
        </TableCell>
        <TableCell className="py-1.5 text-right">
          <Button
            ref={editButton}
            variant="ghost"
            size="sm"
            onClick={() => setEditing(true)}
            aria-label={`Edit ${feed.label}`}
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
      <TableCell colSpan={5} className="p-3">
        <Form
          action={action}
          // Only the label is seeded. The URL field stays empty by design —
          // see `feedUpdateSchema`: blank means "keep the one on file", and a
          // pre-filled value would put the token in the document.
          initialState={{ status: "idle", values: { label: feed.label, url: "" } }}
        >
          {(state) => (
            <>
              <input type="hidden" name="feedId" value={feed.id} />

              <FeedFields state={state} existing />
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
                  value="sync"
                  variant="outline"
                  size="sm"
                  pendingLabel="Syncing…"
                >
                  <ArrowsClockwise aria-hidden="true" />
                  Sync now
                </SubmitButton>
                <SubmitButton name="intent" value="toggle" variant="outline" size="sm">
                  {feed.active ? "Pause" : "Resume"}
                </SubmitButton>

                <span className="ms-auto flex items-center gap-2">
                  {feed.itemCount > 0 ? (
                    <span className="text-muted-foreground text-ui-sm">
                      {feed.itemCount === 1
                        ? "1 synced entry goes too."
                        : `${feed.itemCount} synced entries go too.`}
                    </span>
                  ) : null}
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
              </div>
            </>
          )}
        </Form>
      </TableCell>
    </TableRow>
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
