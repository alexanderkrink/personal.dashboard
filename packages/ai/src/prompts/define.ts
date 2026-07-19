/**
 * Versioned prompt templates (PLAN.md §AI Strategy §3).
 *
 * Every prompt used in production is a `definePrompt` template with an explicit version.
 * Bump the version on ANY semantic change so stored LLM outputs trace back to the exact
 * template that produced them. No inline prompt strings at call sites — a prompt that
 * isn't a `definePrompt` doesn't ship.
 *
 * Templates live one file per feature area under `src/prompts/` and are registered in
 * `src/prompts/index.ts`. This file is the primitive, not a home for templates.
 */

import { JOBS, type JobId } from "../models";

/**
 * What a prompt variable may be.
 *
 * Deliberately wider than the original `string | number` — real prompts render TopicPage
 * JSON, segment lists and critic verdicts, and a constraint that forces every caller to
 * pre-stringify its objects is a constraint every downstream prompt will fight.
 *
 * But it is NOT `unknown`. Vars must stay JSON-serializable because §3 hashes them:
 * `input_hash` is a SHA-256 over the rendered prompt inputs, and that hash is what makes
 * the §5 idempotency short-circuit and targeted regeneration work. A `Date`, a `Map` or a
 * closure among the vars would hash unstably or not at all, so the type rules them out
 * here rather than letting a cache-miss storm explain it later.
 */
export type PromptVarValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly PromptVarValue[]
  | { readonly [key: string]: PromptVarValue };

export type PromptVars = Record<string, PromptVarValue>;

/**
 * A prompt id (§3, normative).
 *
 * Kebab-case, stable, and **equal to the key of the job that runs it**. The version NEVER
 * appears in the id — it lives in the separate `version` field, which is precisely what
 * makes targeted regeneration (`where prompt_id = ? and prompt_version < ?`) possible.
 * A version baked into the id would make every bump look like a different prompt, and
 * that query would silently match nothing.
 *
 * One job may own several prompt *versions*, never several ids. The single legitimate
 * exception is a job owning two genuinely different prompts — `lesson-generate` has a
 * generation prompt and a repair prompt — distinguished by a `variant` suffix on the id
 * (`lesson-generate`, `lesson-generate-repair`), both pinned to the same model.
 *
 * The template-literal type is the compiler half of the enforcement. `promptIdViolation`
 * and the registry test are the other half, because `${JobId}-${string}` on its own would
 * happily accept `topic-merge-v2`.
 */
export type PromptId = JobId | `${JobId}-${string}`;

export interface PromptTemplate<TVars extends PromptVars> {
  /** Stable kebab-case id, equal to the job key that runs it. See {@link PromptId}. */
  id: PromptId;
  /** Bump on every semantic change to the template. Never encoded in the id. */
  version: number;
  description: string;
  render: (vars: TVars) => string;
}

/**
 * A prompt of erased variable shape, for registries and generic machinery.
 *
 * `PromptTemplate<PromptVars>` would not accept `PromptTemplate<{ topic: string }>` —
 * `render` is contravariant in its parameter — so the registry element type erases the
 * variables rather than widening them.
 */
export type AnyPromptTemplate = Omit<PromptTemplate<PromptVars>, "render"> & {
  render: (vars: never) => string;
};

/**
 * Defines a prompt template.
 *
 * `TVars` is inferred from an annotated `render` parameter, or passed explicitly. The
 * constraint is *widened* to JSON-shaped values rather than replaced with
 * `Record<string, unknown>`: `unknown` would still type-check every call but erase the
 * variable names, so `render({ subjekt })` would compile and quietly interpolate
 * `undefined`. Keeping the generic is what preserves that inference.
 */
export function definePrompt<TVars extends PromptVars>(
  template: PromptTemplate<TVars>,
): PromptTemplate<TVars> {
  return template;
}

const KEBAB_CASE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
/** `v2`, `V2` and bare trailing digits — the shapes that smuggle a version into an id. */
const VERSION_LIKE_SEGMENT = /^v?\d+$/i;

/**
 * Resolves a prompt id to the job that runs it, stripping any `variant` suffix.
 *
 * This is how the call wrapper gets from a prompt to a model without the caller naming
 * either, and it is why the id convention is load-bearing rather than cosmetic.
 */
export function jobForPromptId(id: string): JobId | undefined {
  const segments = id.split("-");
  for (let end = segments.length; end > 0; end -= 1) {
    const candidate = segments.slice(0, end).join("-");
    if (candidate in JOBS) return candidate as JobId;
  }
  return undefined;
}

/**
 * Validates a prompt id against the §3 convention. Returns the reason it fails, or
 * `undefined` when it is valid.
 *
 * A convention only a reviewer can catch is one that will drift, so this runs as a test
 * over the whole registry instead of living in prose.
 */
export function promptIdViolation(id: string): string | undefined {
  if (!KEBAB_CASE.test(id)) return `"${id}" is not kebab-case`;

  const job = jobForPromptId(id);
  if (job === undefined) {
    return `"${id}" does not start with a job key from JOBS — a prompt id must equal the job that runs it`;
  }

  const variant = id.slice(job.length).replace(/^-/, "");
  if (variant === "") return undefined;

  for (const segment of variant.split("-")) {
    if (VERSION_LIKE_SEGMENT.test(segment)) {
      return `"${id}" encodes a version in the id ("${segment}") — versions belong in the separate \`version\` field, or \`where prompt_id = ? and prompt_version < ?\` matches nothing`;
    }
  }
  return undefined;
}

/** Throws if `id` violates the §3 convention. */
export function assertPromptId(id: string): asserts id is PromptId {
  const violation = promptIdViolation(id);
  if (violation !== undefined) throw new Error(`Invalid prompt id: ${violation}`);
}
