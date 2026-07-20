#!/usr/bin/env node
/**
 * Verify the function registry Inngest ACTUALLY holds for this app.
 *
 * ## The gap this closes
 *
 * `pnpm inngest:sync` proves the deployed endpoint answered a registration PUT with HTTP
 * 200. It cannot prove what the platform recorded — and the Wave 4 failure mode was exactly
 * a healthy-looking endpoint behind a stale registry: `Events received: 1`,
 * `Executions ran: 0`, a document parked at `queued`, no error anywhere. This script asks
 * Inngest's v2 REST API (`GET /v2/apps/{appId}/functions`, Bearer-authenticated with the
 * environment's signing key) for the registered function list and compares it against the
 * list THIS CODEBASE serves. A function the code serves that the platform does not hold is
 * a document-loss condition, and the exit code says so.
 *
 * ## The expected list is derived from the code, never maintained by hand
 *
 *  1. the app id comes from `new Inngest({ id: ... })` in `apps/web/src/inngest/client.ts`;
 *  2. the served identifiers come from the `functions: [...]` array in
 *     `apps/web/src/app/api/inngest/route.ts`;
 *  3. each identifier's function id comes from the `createFunction({ id: ... })` in the
 *     module its import names — plus `<id>-failure` when that module declares an
 *     `onFailure` handler, because the SDK registers the failure handler as a function of
 *     its own (the platform really does hold `process-document-failure`).
 *
 * A hand-kept list would rot exactly the way the registry does: edited route.ts, forgotten
 * side file, green verify against a stale expectation.
 *
 * ## Use
 *
 *   pnpm inngest:verify                      # verify production's registry
 *   pnpm inngest:verify --expect some-id     # DRILL: assert one extra expected id
 *
 * `--expect` exists so the check can be proven able to fail: run it with an id the platform
 * cannot hold and watch the non-zero exit. A verification that has never failed is a
 * verification, not evidence.
 *
 * Exit codes: 0 = every expected function registered; 1 = at least one missing;
 * 2 = could not derive, authenticate or fetch.
 *
 * Auth: `INNGEST_SIGNING_KEY` from the environment, else read BY NAME from
 * `apps/web/.env.local`. The value is never printed.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const API = "https://api.inngest.com/v2";

const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exit(2);
};

const read = (relative) => {
  try {
    return readFileSync(join(ROOT, relative), "utf8");
  } catch {
    return fail(`Could not read ${relative}`);
  }
};

/* ── 1. The signing key, by name only ─────────────────────────────────────── */

function signingKey() {
  if (process.env.INNGEST_SIGNING_KEY) return process.env.INNGEST_SIGNING_KEY;
  try {
    const envFile = readFileSync(join(ROOT, "apps/web/.env.local"), "utf8");
    const line = envFile.split("\n").find((l) => l.startsWith("INNGEST_SIGNING_KEY="));
    if (line) return line.slice("INNGEST_SIGNING_KEY=".length).trim().replace(/^"|"$/g, "");
  } catch {
    // fall through to the failure below
  }
  return fail("INNGEST_SIGNING_KEY is not in the environment and not in apps/web/.env.local");
}

/* ── 2. The expected registry, derived from the code ──────────────────────── */

function appId() {
  const client = read("apps/web/src/inngest/client.ts");
  const match = /new Inngest\(\s*{[\s\S]*?id:\s*"([^"]+)"/.exec(client);
  if (!match) return fail("Could not find `new Inngest({ id: ... })` in client.ts");
  return match[1];
}

function expectedFunctions() {
  const route = read("apps/web/src/app/api/inngest/route.ts");

  const arrayMatch = /functions:\s*\[([^\]]*)\]/.exec(route);
  if (!arrayMatch) return fail("Could not find the `functions: [...]` array in route.ts");
  const identifiers = arrayMatch[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (identifiers.length === 0) return fail("The `functions: [...]` array parsed as empty");

  const ids = [];
  for (const identifier of identifiers) {
    const importMatch = new RegExp(
      `import\\s*{[^}]*\\b${identifier}\\b[^}]*}\\s*from\\s*"([^"]+)"`,
    ).exec(route);
    if (!importMatch) return fail(`Could not find the import of \`${identifier}\` in route.ts`);
    const modulePath = importMatch[1].replace(/^@\//, "apps/web/src/") + ".ts";
    const module = read(modulePath);

    const idMatch = /createFunction\(\s*{[\s\S]*?id:\s*"([^"]+)"/.exec(module);
    if (!idMatch) return fail(`Could not find createFunction({ id }) in ${modulePath}`);
    ids.push(idMatch[1]);

    // An `onFailure` handler is registered by the SDK as its own `<id>-failure` function.
    // Property syntax only (line-anchored), so prose mentions in comments do not count.
    if (/^\s*onFailure\s*:/m.test(module)) ids.push(`${idMatch[1]}-failure`);
  }
  return ids;
}

/* ── 3. What the platform holds ───────────────────────────────────────────── */

async function registeredFunctions(app, key) {
  const ids = [];
  let cursor = null;
  do {
    const url = `${API}/apps/${encodeURIComponent(app)}/functions?limit=50${
      cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
    }`;
    let response;
    try {
      response = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    } catch (error) {
      return fail(
        `Could not reach the Inngest API: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (response.status === 401) {
      return fail("The Inngest API refused the signing key (HTTP 401). Wrong environment's key?");
    }
    if (response.status === 404) {
      return fail(`The Inngest API holds no app "${app}" (HTTP 404) — the app has never synced.`);
    }
    if (!response.ok) {
      return fail(
        `Inngest API answered HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`,
      );
    }
    const body = await response.json();
    for (const fn of body.data ?? []) ids.push(fn.id);
    cursor = body.page?.hasMore ? (body.page?.cursor ?? null) : null;
  } while (cursor !== null);
  return ids;
}

/* ── 4. Compare, honestly ─────────────────────────────────────────────────── */

const drills = [];
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === "--expect" && process.argv[i + 1]) drills.push(process.argv[++i]);
}

const app = appId();
const expected = [...expectedFunctions(), ...drills];
const registered = await registeredFunctions(app, signingKey());

console.log(`App: ${app}`);
console.log(
  `Expected (derived from the served code${drills.length > 0 ? " + --expect drill" : ""}): ${expected.sort().join(", ")}`,
);
console.log(`Registered (Inngest v2 API):                ${registered.sort().join(", ")}`);

const missing = expected.filter((id) => !registered.includes(id));
const extra = registered.filter((id) => !expected.includes(id));

if (extra.length > 0) {
  console.warn(
    `⚠ The platform holds ${extra.length} function(s) this code does not serve: ${extra.join(", ")}.` +
      "\n  Usually a renamed or removed function's old entry. Not fatal — events cannot be" +
      "\n  lost to an EXTRA function — but worth an eyebrow and a look at the dashboard.",
  );
}

if (missing.length > 0) {
  console.error(
    `✗ ${missing.length} function(s) the code serves are NOT in Inngest's registry: ${missing.join(", ")}.` +
      "\n  Events naming them will count as received and run NOTHING — the Wave 4 failure." +
      "\n  Run `pnpm inngest:sync` after the deploy is live, then verify again.",
  );
  process.exit(1);
}

console.log(`✓ All ${expected.length} expected functions are registered.`);
