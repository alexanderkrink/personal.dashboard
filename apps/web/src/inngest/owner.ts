/**
 * Deriving the owner of a job's work from the DATABASE, never from the event.
 *
 * ## The hole this closes
 *
 * `events.ts` validates `userId: z.uuid()`. That **types** the value; it does not
 * **authorise** it. Jobs run under `createAdminSupabaseClient`, which bypasses RLS
 * entirely, so a handler that takes `event.data.userId` and writes rows with it is
 * a handler in which the *event author* chooses the tenant. Anyone who can get a
 * validly signed event onto the bus — a replay, a leaked event key, a bug in a
 * producer, a future webhook that forwards user input — writes rows for any
 * account in the project, and RLS is not in the path to notice.
 *
 * Wave 3 already proved the endpoint half of this is real rather than theoretical:
 * with `INNGEST_DEV=1` in a production build, an *unsigned* POST ran function code
 * and wrote a `job_heartbeats` row for a user id it picked itself. The signing key
 * closed that. Nothing closes the case where the event is properly signed and the
 * `userId` inside it is simply wrong.
 *
 * ## The rule
 *
 * **The database owns ownership.** A handler is given a row id, and it asks the
 * database who owns that row. Any `userId` in the payload is a *hint* — useful for
 * cross-checking and for logging, never the authority. A hint that disagrees with
 * the database is not a discrepancy to reconcile; it is a security event, and the
 * job fails loudly rather than picking a winner.
 *
 * This is the pattern Wave 4's `process-document` uses:
 *
 * ```ts
 * const { userId } = await deriveOwner(admin, { table: "documents", id: documentId }, {
 *   claimed: event.data.userId,
 *   job: "process-document",
 * });
 * // `userId` is now the database's answer. Write rows with THIS, never with the payload.
 * ```
 *
 * ## Why the locator is typed the way it is
 *
 * `OwnedTable` is computed from the generated `Database` type: it is exactly the set
 * of public tables whose row has a `user_id`, plus `profiles`, which is keyed by
 * `id` because it *is* the user. A table with no ownership column cannot be named
 * here at all — the mistake is unrepresentable rather than merely discouraged, which
 * is the difference between a convention and a rule.
 */

import type { Database, SupabaseAdminClient } from "@study/db";
import { NonRetriableError } from "inngest";

type PublicTables = Database["public"]["Tables"];

/**
 * Every public table that can answer "who owns this row" — i.e. every table whose row
 * carries a `user_id`. Adding an owned table to the schema adds it here automatically;
 * adding an unowned one does not, so it can never be used as an ownership source.
 */
export type UserIdTable = {
  [K in keyof PublicTables]: PublicTables[K]["Row"] extends { user_id: string } ? K : never;
}[keyof PublicTables];

/**
 * `profiles` is the one exception, and it is an exception of *shape*, not of principle:
 * it is keyed by `id` (the `auth.users` id) rather than carrying a `user_id`, because a
 * profile does not belong to a user — it is one. Listing it separately keeps the owner
 * column derivable from the table name alone, so no caller ever supplies it.
 */
export type OwnedTable = UserIdTable | "profiles";

/** Which column names the owner. Never caller-supplied: that is the whole design. */
function ownerColumn(table: OwnedTable): "id" | "user_id" {
  return table === "profiles" ? "id" : "user_id";
}

/** The row a job was asked to work on. Ownership is read from here and nowhere else. */
export interface OwnedRowLocator {
  readonly table: OwnedTable;
  readonly id: string;
}

export interface DeriveOwnerOptions {
  /**
   * The `userId` the event payload claimed, if it carried one. Cross-checked against
   * the database's answer and otherwise ignored. Optional precisely so that a handler
   * whose event has no `userId` is the easy case rather than the awkward one — the
   * database's answer is complete on its own.
   */
  readonly claimed?: string | undefined;
  /** Inngest function id, for the log line when a mismatch is found. */
  readonly job: string;
}

export interface DerivedOwner {
  /** The owner, per the database. The only value a handler may stamp on a row. */
  readonly userId: string;
  readonly table: OwnedTable;
  readonly rowId: string;
}

/**
 * Raised when the payload's `userId` contradicts the row's actual owner.
 *
 * `NonRetriableError` on purpose, and for two independent reasons. Practically: the
 * disagreement is a property of the stored event, so it is identical on every attempt and
 * retrying only repeats it. Substantively: a retry budget is for work that might yet
 * succeed, and this work must never succeed. Preferring either value would be a decision
 * about whose tenant to write into, and there is no version of that decision that is safe
 * to make automatically.
 */
export class OwnerMismatchError extends NonRetriableError {
  constructor(
    readonly locator: OwnedRowLocator,
    readonly claimed: string,
    readonly actual: string,
  ) {
    super(
      `Event claimed userId ${claimed} but ${locator.table}/${locator.id} is owned by ${actual}. ` +
        "Refusing to write: a job runs under the RLS-bypassing admin client, so the database's " +
        "answer is the only ownership check in the path.",
    );
    this.name = "OwnerMismatchError";
  }
}

/** Raised when the row the event points at does not exist (or was deleted mid-flight). */
export class OwnedRowNotFoundError extends NonRetriableError {
  constructor(readonly locator: OwnedRowLocator) {
    super(
      `No ${locator.table} row with id ${locator.id}. The event points at nothing, so there is ` +
        "no owner to derive and nothing to do.",
    );
    this.name = "OwnedRowNotFoundError";
  }
}

/**
 * The typed client cannot follow a `.from()` whose argument is a union — the row type of
 * each table differs, so the chained builder resolves to a union of incompatible shapes.
 * Narrowed here, once, to the only two things this function needs: select a column, filter
 * by id. The runtime call is unchanged; this is a description of the same query in a form
 * TypeScript can carry through a generic table name.
 *
 * Deliberately confined to this module. The alternative — making the caller pass a
 * pre-built query — would put the choice of *which column means owner* back in the
 * caller's hands, which is exactly the decision this module exists to take away.
 */
interface OwnerQueryClient {
  from(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): {
        maybeSingle(): Promise<{
          data: Record<string, unknown> | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
}

/**
 * Asks the database who owns the row this event points at.
 *
 * Throws rather than returning a result type: there is no branch of a handler that should
 * carry on after failing to establish a tenant, and a `Result` invites exactly the
 * `?? event.data.userId` fallback that reopens the hole.
 */
export async function deriveOwner(
  client: SupabaseAdminClient,
  locator: OwnedRowLocator,
  options: DeriveOwnerOptions,
): Promise<DerivedOwner> {
  const column = ownerColumn(locator.table);

  const { data, error } = await (client as unknown as OwnerQueryClient)
    .from(locator.table)
    .select(column)
    .eq("id", locator.id)
    .maybeSingle();

  // Retriable: a transport failure says nothing about ownership, and the next attempt
  // may well answer. Contrast the two NonRetriable cases below, which are answers.
  if (error !== null) {
    throw new Error(
      `Could not derive the owner of ${locator.table}/${locator.id}: ${error.message}`,
    );
  }
  if (data === null) throw new OwnedRowNotFoundError(locator);

  const actual = data[column];
  if (typeof actual !== "string" || actual === "") {
    throw new Error(
      `${locator.table}/${locator.id} has no usable ${column}. Every user-owned table declares it not null, so this means the schema and this helper disagree.`,
    );
  }

  if (options.claimed !== undefined && options.claimed !== actual) {
    // Loud on the way past, not only in the thrown message: the throw surfaces in the
    // Inngest dashboard, but a cross-tenant claim is worth finding in the platform logs
    // too, next to whatever else that deployment was doing at the time.
    console.error(
      `[security] ${options.job}: event userId ${options.claimed} contradicts the owner of ${locator.table}/${locator.id} (${actual}). Refusing.`,
    );
    throw new OwnerMismatchError(locator, options.claimed, actual);
  }

  return { userId: actual, table: locator.table, rowId: locator.id };
}
