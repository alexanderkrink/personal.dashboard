/**
 * The storage path convention, in one place.
 *
 * `{user_id}/{course_id}/{document_id}/{filename}` is not a convention in the
 * "we agreed to do it this way" sense — it is enforced from two directions that
 * neither know about each other:
 *
 *   - **Storage RLS** (20260719092113) checks the FIRST segment is the
 *     uploader's uid, which stops user B writing under user A's prefix. It
 *     cannot check segments 2 and 3, because `storage.objects` knows nothing
 *     about courses or documents.
 *   - **`documents_storage_path_convention`** (20260719175553) checks the whole
 *     path against the row's own `user_id`, `course_id` and `id`, which closes
 *     the other half: a row cannot point at a path belonging to a different
 *     course or a different document.
 *
 * Between them the path is an invariant. This module is what makes the *client*
 * and the *server* build it identically, since the TUS upload names the object
 * and the Server Action names it again when it inserts the row — two call sites
 * that must agree exactly or the insert fails on a check constraint after the
 * bytes have already landed.
 */

/** The private bucket documents live in (20260719092113). */
export const DOCUMENTS_BUCKET = "documents";

/**
 * Supabase's resumable endpoint requires exactly 6 MB chunks — it is not a
 * tunable. A different value makes the upload fail partway with a size error
 * rather than being merely slower.
 */
export const TUS_CHUNK_BYTES = 6 * 1024 * 1024;

const DEL = 0x7f;
const FIRST_PRINTABLE = 0x20;

/** C0 controls and DEL — the characters that have no business in a storage key. */
function isControlCharacter(codePoint: number): boolean {
  return codePoint < FIRST_PRINTABLE || codePoint === DEL;
}

/**
 * Strips a filename down to something safe to put in a storage key.
 *
 * ## Written as a loop rather than a regex, deliberately
 *
 * The character class this needs is "C0 controls plus DEL", and expressing that
 * as a regex literal means putting escape sequences in source that a careless
 * edit can turn into the literal bytes they stand for — which is how a NUL ends
 * up committed. A comparison on `codePointAt` cannot degrade that way: there is
 * no escape to get wrong, and the intent is legible without decoding anything.
 *
 * ## What survives
 *
 * `/`, `\` and `%` become `-`. The first two would silently add a path segment;
 * `%` interacts with the `LIKE` pattern in `documents_storage_path_convention`
 * in ways that are nobody's idea of a good afternoon.
 *
 * Everything else is kept, and that is the point: the real corpus contains
 * `Micro - Unit 3- Elasticities (2026).pptx`, whose spaces, parentheses and
 * hyphens all survive intact. This removes what breaks the path, not what looks
 * untidy — the user reads this name back on the status card.
 */
export function safeStorageFilename(filename: string): string {
  let cleaned = "";

  for (const character of filename) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || isControlCharacter(codePoint)) continue;
    cleaned += character === "/" || character === "\\" || character === "%" ? "-" : character;
  }

  // Leading dots would make a hidden object, and a name of only dots would make
  // a path segment that resolves to a directory.
  while (cleaned.startsWith(".")) cleaned = cleaned.slice(1);
  cleaned = cleaned.trim();

  const fallback = cleaned.length > 0 ? cleaned : "upload";
  // Storage keys have a practical ceiling well above this; 200 keeps the whole
  // path comfortably short while never truncating a real lecture filename.
  return fallback.length > 200 ? fallback.slice(0, 200) : fallback;
}

export interface StoragePathParts {
  readonly userId: string;
  readonly courseId: string;
  readonly documentId: string;
  readonly filename: string;
}

/** `{user_id}/{course_id}/{document_id}/{filename}` — the one true spelling. */
export function storagePathFor(parts: StoragePathParts): string {
  return [parts.userId, parts.courseId, parts.documentId, safeStorageFilename(parts.filename)].join(
    "/",
  );
}
