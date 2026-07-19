/**
 * The prompt registry (PLAN.md §AI Strategy §3).
 *
 * **One file per feature area** in this directory — `documents.ts`, `flashcards.ts`,
 * `syllabus.ts`, … — each exporting `definePrompt` templates, all of them re-exported
 * *and* listed in `PROMPT_REGISTRY` below.
 *
 * Two rules make the registry worth having:
 * 1. Every production prompt is listed here. `prompts.registry.test.ts` enforces the §3
 *    id convention over this array, so a template that drifts fails CI rather than a code
 *    review. A prompt not in this array is invisible to that check.
 * 2. A prompt's `id` equals the job key that runs it — see {@link PromptId}. That is what
 *    lets the call wrapper resolve prompt → job → `(provider, model)` with the caller
 *    naming neither.
 *
 * The M0 placeholder (`echo-example`) was retired rather than carried forward: its id named
 * no job, so it could not satisfy the convention this module exists to enforce, and a
 * placeholder that has to be exempted from the rule is worse than no placeholder.
 * `syllabus-components` (M1 item 11) is the first real entry.
 */

import type { AnyPromptTemplate } from "./define";
import { docStructuringPrompt, docStructuringSlideTextPrompt } from "./documents";
import { syllabusComponentsPrompt } from "./syllabus";

export {
  type AnyPromptTemplate,
  assertPromptId,
  definePrompt,
  jobForPromptId,
  type PromptId,
  type PromptTemplate,
  type PromptVars,
  type PromptVarValue,
  promptIdViolation,
} from "./define";

/**
 * Every production prompt template, in one array.
 *
 * Add an entry in the same commit that adds the template — the id-convention and
 * uniqueness checks only cover what is listed here.
 */
export const PROMPT_REGISTRY: readonly AnyPromptTemplate[] = [
  syllabusComponentsPrompt,
  docStructuringPrompt,
  docStructuringSlideTextPrompt,
];

export {
  DOC_STRUCTURING_SYSTEM,
  docStructuringPrompt,
  docStructuringSlideTextPrompt,
} from "./documents";
export { SYLLABUS_COMPONENTS_SYSTEM, syllabusComponentsPrompt } from "./syllabus";
