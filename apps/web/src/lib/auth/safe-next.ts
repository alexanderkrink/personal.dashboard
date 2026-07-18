/**
 * Resolution of a caller-supplied `?next=` into a same-origin path.
 *
 * The auth landing routes (`/auth/confirm`, `/auth/callback`) take a `next`
 * from the query string and send the visitor there once a token checks out.
 * Building that redirect by concatenation — `` `${origin}${next}` `` — looks
 * same-origin but is not:
 *
 *   next = "@evil.com"  ->  "http://studydash.app@evil.com"
 *
 * where the real host becomes the URL's *userinfo* and the browser navigates to
 * evil.com. `//evil.com` and `https://evil.com` happen to survive concatenation
 * unharmed, which makes the bug easy to eyeball as safe and easy to reintroduce.
 * Resolving the value against the origin and then re-comparing the origin is the
 * only check that catches every shape.
 */

/**
 * Returns `next` as an origin-relative `path?query` when it resolves to the
 * same origin, and `fallback` otherwise (absolute URL, protocol-relative,
 * userinfo trick, or unparseable).
 */
export function safeNext(
  next: string | null | undefined,
  origin: string,
  fallback: string,
): string {
  if (!next) return fallback;

  try {
    const base = new URL(origin);
    const resolved = new URL(next, base);
    if (resolved.origin !== base.origin) return fallback;
    return `${resolved.pathname}${resolved.search}`;
  } catch {
    return fallback;
  }
}
