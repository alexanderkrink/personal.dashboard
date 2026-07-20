/**
 * The state a natural-language quick-add parse hands back to the client (§6 steps 1–3).
 *
 * Lives outside the `"use server"` module because a Server Action file may export only
 * async functions; the client component and the action share this contract.
 *
 * Two shapes beyond idle, and the asymmetry is the design:
 *
 * - `parsed` carries `values` in exactly the `FormState.values` shape the structured
 *   quick-add form seeds from (`QUICK_ADD_FIELDS`, strings, `""` for absent). The parse
 *   result IS a pre-filled instance of the same form — §6: "the structured form is the
 *   fallback, not a separate feature" — so there is deliberately no second component and
 *   no mapping layer between "what the model proposed" and "what the human confirms".
 *
 * - `fallback` carries only a sentence. A failed, low-confidence or unavailable parse
 *   degrades to the SAME form, empty. Note what `fallback` cannot carry: values. The
 *   type is the reminder that a parse the app did not trust must not leak fields onto
 *   the card anyway.
 *
 * Neither shape can carry a database row, an id of something created, or any other
 * evidence of a write — because the parse never writes. The Server Action that persists
 * (`createQuickAddItem`) takes the confirm card's own `FormData`, which only a human
 * submit produces.
 */

export type QuickAddProposalValues = Readonly<Record<string, string>>;

export type QuickAddParseState =
  | { readonly status: "idle" }
  | { readonly status: "fallback"; readonly message: string }
  | {
      readonly status: "parsed";
      /** `QUICK_ADD_FIELDS` → string, ready to seed the confirm card. */
      readonly values: QuickAddProposalValues;
      /** The model's own ambiguity note, shown beside the card. Null when clean. */
      readonly note: string | null;
      /** Unique per parse — the confirm card remounts on it so new values re-seed. */
      readonly token: string;
    };

export const IDLE_QUICK_ADD_PARSE_STATE: QuickAddParseState = { status: "idle" };
