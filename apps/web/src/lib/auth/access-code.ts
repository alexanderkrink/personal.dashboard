/**
 * The access-code gate.
 *
 * A single shared code (`ACCESS_CODE`) stands in front of the entire auth
 * surface: without it, `/login` and `/signup` do not exist as far as a visitor
 * is concerned. Clearing the gate mints a cookie derived from the code itself,
 * so the gate is completely stateless — no table, no session, no revocation
 * list. Rotating the code invalidates every cookie already issued, because
 * every cookie is a function of the code.
 *
 * RUNTIME CONSTRAINT: this module is imported by `src/proxy.ts`, which Next
 * runs on the Edge runtime. `node:crypto` — and therefore `timingSafeEqual` —
 * is unavailable there. Everything below uses only the Web Crypto global
 * (`crypto.subtle`), which exists on the Edge runtime, in Node 20+, and in the
 * browser, so one implementation serves the proxy and the Server Action alike.
 */

/**
 * Domain separator for the cookie token. Keeps `sha256(code)` — a value an
 * attacker could precompute from a guessed code — from being the cookie value
 * itself, and gives us a version handle if the token format ever changes.
 */
const GATE_TOKEN_DOMAIN = "study-dashboard/access-gate/v1";

/** Name of the httpOnly cookie that records a cleared gate. */
export const GATE_COOKIE_NAME = "sd_access_gate";

/** One year. The gate is a speed bump on a personal dashboard, not a session. */
export const GATE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time comparison of two equal-length strings.
 *
 * Only ever called on SHA-256 hex digests, which are always 64 characters, so
 * the length guard below is a type-safety net rather than a secret-dependent
 * branch — it can never fire on real input and therefore leaks nothing about
 * how much of a candidate value matched.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * Hash both operands to fixed-width digests, then compare in constant time.
 *
 * Hashing first is what removes the length leak: comparing raw secrets would
 * have to bail out early on a length mismatch, telling an attacker how long the
 * real value is. Digests are always the same width, so the comparison loop runs
 * the full 64 characters no matter what was submitted.
 */
async function digestEqual(a: string, b: string): Promise<boolean> {
  const [digestA, digestB] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  return constantTimeEqual(digestA, digestB);
}

/** The cookie value proving the gate was cleared for this exact access code. */
export function gateCookieToken(accessCode: string): Promise<string> {
  return sha256Hex(`${GATE_TOKEN_DOMAIN}:${accessCode}`);
}

/** True when the submitted code matches the configured one. Constant time. */
export function isAccessCodeValid(submitted: string, accessCode: string): Promise<boolean> {
  return digestEqual(submitted.trim(), accessCode);
}

/** True when the cookie carries a token minted from the current access code. */
export async function isGateCookieValid(
  cookieValue: string | undefined,
  accessCode: string,
): Promise<boolean> {
  if (cookieValue === undefined) return false;
  return digestEqual(cookieValue, await gateCookieToken(accessCode));
}
