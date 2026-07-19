/**
 * Document-extraction prompt templates (PLAN §4.1/§4.2, AI Strategy §3).
 *
 * Two templates, one job. Both resolve to `doc-structuring`
 * (`gemini-3.1-pro-preview`) because a prompt's id equals the key of the job that runs it,
 * and the second carries a `variant` suffix — the same shape `lesson-generate` /
 * `lesson-generate-repair` uses:
 *
 * - `doc-structuring` — the **file** branch. The document itself is attached as a `file`
 *   part; the template says how to read it, and the schema says what to return. Used by
 *   native PDFs and by PPTX decks that were converted to PDF.
 * - `doc-structuring-slide-text` — the **text** branch. `packages/core` has already parsed
 *   the PPTX zip into per-slide markdown, so the model is structuring text it can see in
 *   full rather than reading an image.
 *
 * ## Why two templates rather than one with a conditional
 *
 * They give genuinely different instructions. The file branch has to be told that a
 * diagram is content and that page numbers must match what is printed; the text branch has
 * to be told that it is looking at a lossy transcript of a visual artifact and must not
 * invent what the images contained. Folding both into one template with an `if` would
 * produce a prompt that is half-wrong on every call, and would make the version number
 * meaningless — a bump would signal a change to callers it did not affect.
 *
 * The shared rules live in `EXTRACTION_RULES` so the two cannot drift on the things they
 * genuinely agree about.
 */

import { definePrompt } from "./define";

/**
 * The rules both branches share.
 *
 * `skipped` gets the most words here for the reason the schema gives: it is the only field
 * whose *empty* value is a substantive claim, and a model left to its own devices will
 * return `[]` while having quietly dropped the title slide.
 */
const EXTRACTION_RULES = [
  "Rules:",
  "- Extract, do not summarise. The markdown you return per page IS the study material — it gets chunked, embedded and searched. A summary is a lossy replacement for the thing you were asked for.",
  "- Account for EVERY page. Each page either appears in `pages` or falls inside a range in `skipped`. There is no third option, and a page that is in neither is a silent loss.",
  "- `skipped` is not optional bookkeeping. If you leave out a title slide, an agenda, a table of contents, a bibliography, a 'thank you' or 'any questions?' page, or a duplicate — declare it, with its page number and a reason. Returning an empty `skipped` while having dropped pages is the single worst thing you can do here.",
  "- Page numbers must be the ones a reader would count, starting at 1, and every `page` you cite must be a page that actually exists.",
  "- `examSignals` are for explicit statements only — the lecturer saying this is examinable, a 'key formula' banner, 'you must know this'. Quote them verbatim with their page. Most documents have none, and an empty array is the right answer far more often than not. An invented signal re-orders a student's revision.",
  "- Keep the document's own language. Do not translate. If the deck is in Spanish, the markdown is in Spanish.",
  "- Formulas as LaTeX. Tables as markdown tables. Never drop a table because it is awkward.",
].join("\n");

/**
 * The file branch — a PDF (native, or converted from PPTX) attached as a `file` part.
 *
 * The instruction about figures is the one that earns its place: on a deck at 22 words per
 * slide, essentially all of the content is in the images, and a model reading it as a
 * document will otherwise return a page of markdown containing the slide title and
 * nothing else.
 */
export const docStructuringPrompt = definePrompt({
  id: "doc-structuring",
  version: 1,
  description:
    "Reads an attached PDF (native, or converted from a visual PPTX) page by page and returns per-page markdown, document structure, exam signals with page numbers, a proposed session label, and an explicit list of deliberately skipped page ranges.",
  render: ({
    courseTitle,
    filename,
    pageHint,
  }: {
    courseTitle: string;
    filename: string;
    pageHint: string;
  }) =>
    [
      `You are reading a university course document for the course "${courseTitle}" and turning it into structured study material.`,
      "",
      `The file is attached. Its name is "${filename}".${pageHint}`,
      "",
      "Read it as a student would — look at every page, including the pictures. Diagrams, charts, screenshots, photographs of a whiteboard and equations rendered as images are CONTENT, not decoration. On lecture slides they are usually the *majority* of the content: a slide whose only text is 'Market segmentation' may carry a four-quadrant diagram that is the entire point of the slide. Write what the figure shows into that page's markdown, in enough detail that someone revising from your text alone would not need the picture.",
      "",
      EXTRACTION_RULES,
      "- If a page is a photograph or scan of text, read the text off it. Do not describe it as 'a scanned page'.",
      "",
      "Finally, propose a `sessionLabel` from what the document itself prints on its title page or in its header/footer — 'Session 1', 'Lecture 7', 'Unit 3'. Do not derive one from the filename, and return null if the document does not say.",
    ].join("\n"),
});

/**
 * The text branch — per-slide markdown already parsed out of the `.pptx` zip.
 *
 * The honesty instruction ("you cannot see the images") is load-bearing. Handed a sparse
 * transcript of a visual deck, a model will cheerfully reconstruct a plausible diagram
 * description from the slide title, and that fabrication is indistinguishable from
 * extraction downstream. The deck that reaches this branch is supposed to be text-rich; if
 * it is not, the correct output is thin, and thin is what the fidelity note explains.
 */
export const docStructuringSlideTextPrompt = definePrompt({
  id: "doc-structuring-slide-text",
  version: 1,
  description:
    "Structures per-slide markdown parsed from a PPTX zip (shape text, tables and speaker notes) into the same extraction shape as the PDF branch, without access to the slide images.",
  render: ({
    courseTitle,
    filename,
    slideCount,
    slideMarkdown,
  }: {
    courseTitle: string;
    filename: string;
    slideCount: number;
    slideMarkdown: string;
  }) =>
    [
      `You are structuring a university lecture deck for the course "${courseTitle}" into study material.`,
      "",
      `The deck is "${filename}" and has ${slideCount} slides. Below is the text extracted from its PowerPoint XML: shape text, tables, and — where the lecturer wrote any — speaker notes, marked as "> **Speaker notes:**".`,
      "",
      "⚠ You are reading a TEXT-ONLY transcript. The slide images, diagrams and charts are NOT included and you cannot see them. Never describe a figure you have not been shown, and never reconstruct one from a slide title — a plausible invention is worse than an admitted gap, because nothing downstream can tell the two apart. If a slide's text is thin, its extracted markdown should be thin.",
      "",
      "Speaker notes are the lecturer's own commentary and frequently contain what the slide does not — assessment rules, emphasis, worked reasoning. Treat them as first-class content, and fold them into that slide's markdown rather than dropping them.",
      "",
      EXTRACTION_RULES,
      "",
      "Finally, propose a `sessionLabel` from what the slides themselves print — 'Session 1', 'Lecture 7', 'Unit 3'. Do not derive one from the filename, and return null if the deck does not say.",
      "",
      "SLIDE TEXT:",
      "---",
      slideMarkdown,
      "---",
    ].join("\n"),
});

/**
 * The system prompt for both branches.
 *
 * Stable across template versions and shared, because the posture is the same either way:
 * completeness over polish, and declared gaps over invisible ones.
 */
export const DOC_STRUCTURING_SYSTEM =
  "You turn university course documents into structured study material. You are exhaustive rather than concise: the text you produce replaces the original for a student revising from it, so anything you leave out is gone. You never invent content you were not shown, and when you deliberately drop a page you always say which and why.";
