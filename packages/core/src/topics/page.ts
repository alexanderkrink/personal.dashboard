/**
 * The **structural** shape of a TopicPage, and the flattening that makes it diffable.
 *
 * ## Why these types live here and not next to the Zod schema
 *
 * PLAN "Document & Notes Pipeline" §2 puts the TopicPage *schema* in `packages/ai` — it is
 * an LLM output contract, and that is where LLM output contracts live. But the three
 * deterministic checks that make the merge trustworthy (the duplicate guard, the block-diff
 * loss-detector, segmentation) are pure functions with no model in them, and PLAN's §5 is
 * explicit that they are "code, not LLM". Putting them in `packages/ai` would make the one
 * part of the merge that never calls a provider live inside the provider package.
 *
 * So the algorithms are here, and they are typed **structurally** rather than against an
 * import: every field is optional and every collection is `readonly`, so
 * `z.infer<typeof topicPageSchema>` from `@study/ai` is assignable to `TopicPageLike`
 * without either package importing the other. The assignability is checked by the compiler
 * at the call site in `apps/web`, which imports both — a real check at the place the two
 * actually meet, rather than a restated type that can drift.
 *
 * ## Everything is optional on purpose
 *
 * `topics.page` is `jsonb not null default '{}'` (migration `20260719175553`). A brand-new
 * topic row therefore holds a bare `{}` with **none** of the six fields present, and PLAN's
 * §5 Step B feeds exactly that to the merger as "an empty current page". Anything that
 * reads a stored page has to tolerate it, so the types say so instead of leaving it to a
 * `?? []` that somebody forgets.
 */

/**
 * Where in a document a piece of content came from.
 *
 * `{page}` for PDFs, `{slide}` for decks — the vocabulary `topic_sources.locators` is
 * commented with (`[{page:12},{slide:4}]`). Both are optional and the pair is not a
 * discriminated union, because a stored locator is an external input: a row written by an
 * older version of this code, or by a model that emitted neither key, must parse rather
 * than throw. {@link locatorUnit} is where the "neither is present" case is handled once.
 */
export interface LocatorLike {
  readonly page?: number | null;
  readonly slide?: number | null;
}

/** One block-level provenance entry: which document, and where in it. */
export interface BlockSourceLike {
  readonly documentId?: string | null;
  readonly locator?: LocatorLike | null;
}

export interface NoteBlockLike {
  readonly id?: string | null;
  readonly heading?: string | null;
  readonly markdown?: string | null;
  readonly sources?: readonly BlockSourceLike[] | null;
}

export interface KeyTermLike {
  readonly term?: string | null;
  readonly definition?: string | null;
  readonly sources?: readonly BlockSourceLike[] | null;
}

export interface FormulaLike {
  readonly name?: string | null;
  readonly latex?: string | null;
  readonly explanation?: string | null;
  readonly sources?: readonly BlockSourceLike[] | null;
}

export interface WorkedExampleLike {
  readonly problem?: string | null;
  readonly solution?: string | null;
  readonly sources?: readonly BlockSourceLike[] | null;
}

export interface OpenQuestionLike {
  readonly question?: string | null;
  readonly context?: string | null;
  readonly kind?: string | null;
  readonly sources?: readonly BlockSourceLike[] | null;
}

/** PLAN §2's TopicPage, structurally. See the module note on why everything is optional. */
export interface TopicPageLike {
  readonly summary?: string | null;
  readonly notes?: readonly NoteBlockLike[] | null;
  readonly keyTerms?: readonly KeyTermLike[] | null;
  readonly formulas?: readonly FormulaLike[] | null;
  readonly workedExamples?: readonly WorkedExampleLike[] | null;
  readonly openQuestions?: readonly OpenQuestionLike[] | null;
}

/** The five block families the loss-detector tracks. `openQuestions` is deliberately absent. */
export type BlockKind = "note" | "keyTerm" | "formula" | "workedExample";

/**
 * One unit of content, flattened out of a TopicPage so two pages can be diffed.
 *
 * `key` is the **identity** across a merge. It is what makes "this block disappeared" a
 * fact rather than a guess, so how each kind derives it is the load-bearing decision in
 * this module — see {@link flattenTopicPage}.
 */
export interface DiffBlock {
  readonly key: string;
  readonly kind: BlockKind;
  /** Short human label for the finding text. Never used for identity. */
  readonly label: string;
  /** The block's content, for the emptied-out check. */
  readonly text: string;
  readonly sources: readonly BlockSourceLike[];
}

/**
 * Normalizes a string into an identity key.
 *
 * Case-folded, punctuation-stripped, whitespace-collapsed — because a merger that
 * re-capitalises a heading or adds a trailing period has **edited** a block, not deleted
 * one and created another. Without this the loss-detector would report a red flag on every
 * cosmetic touch-up and be switched off within a week.
 */
export function identityKey(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      // Strip combining marks so "café" and "cafe" are one term. Written as escapes: a
      // literal combining-mark range in source is invisible in a diff and in a review.
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
  );
}

/** First `words` words of `value`, for deriving a key from a long free-text field. */
function firstWords(value: string, words: number): string {
  return value.split(/\s+/).filter(Boolean).slice(0, words).join(" ");
}

/**
 * Flattens a TopicPage into keyed blocks.
 *
 * ## How each kind gets its identity
 *
 * - **notes** → the model-assigned `id`. Notes are free-form markdown whose heading and body
 *   are both expected to change during an "integrate, don't append" merge, so there is no
 *   content-derived key that survives a legitimate edit. The id is the only stable handle,
 *   which is why `topicPageSchema` requires it and the merge prompt is emphatic that
 *   existing ids must be carried through unchanged. A note with **no** id falls back to its
 *   heading; a note with neither is keyed by position, which is weak but strictly better
 *   than dropping it out of the diff entirely (an unkeyable block would otherwise be
 *   invisible to the very check that exists to notice missing blocks).
 * - **keyTerms** → the term. A definition is meant to be refined; the term being defined is
 *   the thing that must not vanish.
 * - **formulas** → the name, falling back to the LaTeX when a formula is unnamed.
 * - **workedExamples** → the first eight words of the problem statement. Coarse on purpose:
 *   the solution is what a merge improves, and keying on the whole problem would make any
 *   rewording look like a deletion plus an insertion.
 *
 * `openQuestions` are deliberately NOT flattened. They are the *output* of the conflict rule
 * in §5 Step B — a merge is supposed to add and resolve them as new material arrives — so
 * treating their disappearance as content loss would flag the pipeline working correctly.
 */
export function flattenTopicPage(page: TopicPageLike): readonly DiffBlock[] {
  const blocks: DiffBlock[] = [];

  (page.notes ?? []).forEach((note, index) => {
    const id = (note?.id ?? "").trim();
    const heading = (note?.heading ?? "").trim();
    const identity = id !== "" ? id : heading !== "" ? identityKey(heading) : `index:${index}`;
    blocks.push({
      key: `note:${identity}`,
      kind: "note",
      label: heading !== "" ? heading : id !== "" ? id : `note ${index + 1}`,
      text: (note?.markdown ?? "").trim(),
      sources: note?.sources ?? [],
    });
  });

  (page.keyTerms ?? []).forEach((entry, index) => {
    const term = (entry?.term ?? "").trim();
    blocks.push({
      key: `keyTerm:${term !== "" ? identityKey(term) : `index:${index}`}`,
      kind: "keyTerm",
      label: term !== "" ? term : `key term ${index + 1}`,
      text: (entry?.definition ?? "").trim(),
      sources: entry?.sources ?? [],
    });
  });

  (page.formulas ?? []).forEach((entry, index) => {
    const name = (entry?.name ?? "").trim();
    const latex = (entry?.latex ?? "").trim();
    const identity = name !== "" ? name : latex !== "" ? latex : `index:${index}`;
    blocks.push({
      key: `formula:${identityKey(identity)}`,
      kind: "formula",
      label: name !== "" ? name : latex !== "" ? latex : `formula ${index + 1}`,
      text: `${latex} ${(entry?.explanation ?? "").trim()}`.trim(),
      sources: entry?.sources ?? [],
    });
  });

  (page.workedExamples ?? []).forEach((entry, index) => {
    const problem = (entry?.problem ?? "").trim();
    const identity = problem !== "" ? identityKey(firstWords(problem, 8)) : `index:${index}`;
    blocks.push({
      key: `workedExample:${identity}`,
      kind: "workedExample",
      label: problem !== "" ? firstWords(problem, 8) : `worked example ${index + 1}`,
      text: (entry?.solution ?? "").trim(),
      sources: entry?.sources ?? [],
    });
  });

  return blocks;
}

/**
 * The page/slide number a locator names, or `null` when it names neither.
 *
 * `null` is a real answer and not an error: a merger may legitimately cite a document
 * without pinning a page (a document-level claim), and the loss-detector treats an
 * un-pinned citation as unverifiable rather than as a phantom. Inventing `0` here would
 * silently turn every such citation into a red flag against page zero.
 */
export function locatorUnit(locator: LocatorLike | null | undefined): number | null {
  if (locator === null || locator === undefined) return null;
  const page = locator.page;
  if (typeof page === "number" && Number.isFinite(page)) return page;
  const slide = locator.slide;
  if (typeof slide === "number" && Number.isFinite(slide)) return slide;
  return null;
}
