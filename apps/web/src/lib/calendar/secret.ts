/**
 * Feed-URL masking and error redaction.
 *
 * An ICS subscription URL embeds a capability token: whoever holds the string
 * can read the whole calendar, forever, with no login. It is a password that
 * happens to be shaped like a URL, and it is handled like one — stored per-user
 * in `calendar_feeds.config` (never an env var), masked everywhere it is shown,
 * and never written to a log, an error message, or `last_sync_error`.
 *
 * Pure and dependency-free so it can be used on either side of the server
 * boundary and unit-tested directly.
 */

/** What a masked URL shows instead of the path. */
const MASK = "••••••••";

/**
 * Rewrites `webcal://` to `https://`.
 *
 * `webcal:` is not a transport — it is the same HTTPS URL wearing a scheme that
 * means "hand this to a calendar app", and it is what a university's
 * "Subscribe" button almost always produces. Refusing the exact string the user
 * was handed would be obtuse, so it is normalized instead.
 *
 * Shared with `icsFeedConfigSchema` deliberately. When it lived only in the
 * schema, a row stored before normalization rendered as a bare mask with no
 * origin at all: `new URL("webcal://…").origin` is the string `"null"`, because
 * `webcal` is not a *special* scheme in the URL spec. Caught in a browser, not
 * by any of the four checks.
 */
export function normalizeFeedUrl(url: string): string {
  return url.startsWith("webcal://") ? `https://${url.slice(9)}` : url;
}

/**
 * A feed URL reduced to something safe to render.
 *
 * Shows the **origin only**. The path is replaced wholesale, because on this
 * feed the token IS the path — there is no "safe prefix" to keep, and a
 * last-four-characters style hint (the credit-card convention) would leak real
 * token bytes for no real benefit. Two feeds on the same host are told apart by
 * `calendar_feeds.label`, which is user-supplied and carries no secret, and by
 * `feedFingerprint()` below.
 *
 * A string that will not parse as a URL never gets echoed back — it could be
 * anything, including a token pasted into the wrong box — so it degrades to a
 * bare mask.
 */
export function maskFeedUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(normalizeFeedUrl(url));
  } catch {
    return MASK;
  }
  // `origin` is "null" for opaque schemes (data:, blob:). Anything that is not
  // an http(s) origin is not a feed URL we should be rendering at all.
  if (parsed.origin === "null") return MASK;
  return `${parsed.origin}/${MASK}`;
}

/**
 * A short, stable, NON-reversible id for a feed URL.
 *
 * Lets the UI say "this is a different feed from that one" without showing a
 * single byte of the token. Deliberately a plain string hash and not a
 * cryptographic one: it is an identity hint, never a security boundary, and
 * making it synchronous keeps it usable during render (`crypto.subtle` is
 * async).
 */
export function feedFingerprint(url: string): string {
  // FNV-1a, 32-bit.
  let hash = 0x811c9dc5;
  for (let index = 0; index < url.length; index += 1) {
    hash ^= url.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 6);
}

/** What replaces a secret once it has been found in a string. */
const REDACTED = "[redacted]";

/**
 * Any URL-looking substring, so a secret can be scrubbed even when we do not
 * know the exact value to look for.
 *
 * This is the important half of redaction. `fetch` failures, DNS errors and
 * `URL` constructor errors all splice the offending URL into their `message`,
 * so an error propagated verbatim into `last_sync_error` would persist the
 * token into a column the client reads back. Catching the shape rather than the
 * value means a token still gets scrubbed when it arrives somewhere we did not
 * anticipate.
 */
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/**
 * Scrubs a message before it is stored, shown or logged.
 *
 * Two passes, and both are needed:
 *  1. **Known secrets**, replaced by exact match — catches a token that appears
 *     without its scheme (a bare path fragment, a query value quoted on its own).
 *  2. **Anything URL-shaped**, replaced by pattern — catches the token inside an
 *     error message from code that never knew it was handling a secret.
 *
 * Order matters: known values first, so a partial match cannot survive by
 * hiding inside a URL that pass 2 would only partly consume.
 */
export function redactSecrets(message: string, secrets: readonly string[] = []): string {
  let scrubbed = message;

  for (const secret of secrets) {
    // A short "secret" would match everywhere and turn the message to noise;
    // it also cannot be a real capability token.
    if (secret.length < 8) continue;
    scrubbed = scrubbed.split(secret).join(REDACTED);

    // The path and query of a feed URL are the parts that actually carry the
    // token, and they show up on their own in plenty of error messages.
    try {
      const parsed = new URL(secret);
      for (const part of [parsed.pathname, parsed.search, parsed.hash]) {
        if (part.length >= 8) scrubbed = scrubbed.split(part).join(REDACTED);
      }
    } catch {
      // Not a URL; the exact-match pass above was the whole job.
    }
  }

  return scrubbed.replace(URL_LIKE, REDACTED);
}
