/**
 * Versioned prompt templates.
 *
 * Every prompt used in production is defined here with an explicit version.
 * Bump the version on any semantic change so stored LLM outputs can be
 * traced back to the exact prompt that produced them.
 */
export interface PromptTemplate<TVars extends Record<string, string | number>> {
  /** Stable identifier, kebab-case, unique across the app. */
  id: string;
  /** Bump on every semantic change to the template. */
  version: number;
  description: string;
  render: (vars: TVars) => string;
}

export function definePrompt<TVars extends Record<string, string | number>>(
  template: PromptTemplate<TVars>,
): PromptTemplate<TVars> {
  return template;
}

/**
 * Example template establishing the pattern. Real prompts arrive with M1
 * (document pipeline). Keep one file per feature area under src/prompts/.
 */
export const echoPrompt = definePrompt<{ subject: string }>({
  id: "echo-example",
  version: 1,
  description: "Placeholder template demonstrating the prompt registry pattern.",
  render: ({ subject }) => `Summarize the following subject in one sentence: ${subject}`,
});
