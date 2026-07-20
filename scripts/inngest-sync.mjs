#!/usr/bin/env node
/**
 * Re-register this app's Inngest functions against the deployed endpoint.
 *
 * ## Why this exists
 *
 * Inngest learns which functions exist by calling `PUT /api/inngest` and asking the
 * deployment to introspect itself. Nothing does that automatically here: the Inngest app
 * shows `Vercel project: -`, meaning the Vercel↔Inngest integration is not installed, so a
 * deploy does NOT resync. The registry therefore keeps whatever function set it was told
 * about the last time somebody synced.
 *
 * That failure is silent and total. Wave 4 shipped `processDocument` against a registry
 * eight hours older than the function: Inngest reported `Events received: 1`,
 * `Executions ran: 0`, the document sat at `queued`, and no error appeared anywhere —
 * because from Inngest's point of view the function did not exist to run.
 *
 * ## Use
 *
 *   pnpm inngest:sync                      # production (www.alexanderkrink.com)
 *   pnpm inngest:sync https://foo.vercel.app
 *
 * Run it after any deploy that adds, removes or renames a function in the `functions:`
 * array of `apps/web/src/app/api/inngest/route.ts`. It is safe to run at any time and safe
 * to run twice.
 *
 * ⚠ This is a stopgap for a missing integration, and it depends on a human remembering.
 * The durable fix is installing the Vercel↔Inngest integration, which requires dashboard
 * and OAuth access and therefore cannot be done by an agent. See PLAN.md.
 *
 * ## Notes on the response
 *
 * A successful sync answers `{"message":"Successfully registered","modified":true}`.
 * `modified` is `true` on every call, including back-to-back ones — Inngest records each
 * sync rather than diffing against the previous registry, so it is NOT a staleness signal
 * and this script does not treat it as one. HTTP 200 is the success condition.
 *
 * A 401 from GET on this endpoint is normal and not a problem: introspection is signed,
 * and `serve()` refuses unsigned reads. The sync PUT is the supported unauthenticated
 * entry point.
 */

const DEFAULT_HOST = "https://www.alexanderkrink.com";

const host = (process.argv[2] ?? DEFAULT_HOST).replace(/\/+$/, "");
const endpoint = `${host}/api/inngest`;

console.log(`Syncing Inngest functions against ${endpoint} …`);

let response;
try {
  response = await fetch(endpoint, { method: "PUT" });
} catch (error) {
  console.error(`✗ Could not reach ${endpoint}: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

const body = await response.text();

if (!response.ok) {
  console.error(`✗ Sync failed: HTTP ${response.status}`);
  console.error(body.slice(0, 500));
  // A 401 here (rather than on GET) means the deployment believes it is in cloud mode and
  // rejected the sync — usually a signing-key mismatch between Vercel and Inngest.
  if (response.status === 401) {
    console.error(
      "\nHTTP 401 on PUT usually means INNGEST_SIGNING_KEY in Vercel does not match the\n" +
        "signing key of the Inngest environment you are syncing to.",
    );
  }
  process.exit(1);
}

console.log(`✓ HTTP ${response.status} ${body}`);
console.log(
  "\nRegistered. Confirm the function list in the Inngest dashboard — this script can\n" +
    "prove the endpoint answered, but not which functions Inngest recorded.",
);
