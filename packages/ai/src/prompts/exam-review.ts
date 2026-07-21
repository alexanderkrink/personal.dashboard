/**
 * The exam-review prompt (PLAN §9 *"Generation (`exam-review` · claude-opus-4-8, on
 * demand)"*).
 *
 * One Opus call per course. It is handed every topic page with its exam weight and the
 * course's exam-format profile, and it returns the {@link examReviewSchema} shape: prioritized
 * sections whose depth tracks the weight, a consolidated formula sheet, a question bank, and a
 * weak-spots list drawn from the topics' own open questions and conflicts.
 *
 * ## Why the weight is in the index, not just the ordering
 *
 * §9 is explicit that "depth proportional to weight — high-weight topics get condensed notes,
 * formulas, one worked example, pitfalls; low-weight get 2–3 lines". The model can only honour
 * that if it is *told* each topic's weight, so the index carries it as a number the prompt
 * refers to directly. Ordering alone would let a model spend equal effort on every topic and
 * still call the output "prioritized".
 *
 * The `id` is `exam-review` — equal to the JOB key that runs it, per §3, with the version in
 * the separate `version` field and never in the id.
 */

import { definePrompt } from "./define";

export const examReviewPrompt = definePrompt({
  id: "exam-review",
  version: 1,
  description:
    "Generates a course's final-exam review from its topic pages and exam weights: prioritized topic sections (depth proportional to weight), a consolidated formula sheet, a likely-exam-questions bank with answers, and a weak-spots list, every item carrying topic ids for click-through.",
  render: ({
    courseTitle,
    examFormat,
    topicIndex,
  }: {
    courseTitle: string;
    examFormat: string;
    topicIndex: string;
  }) =>
    [
      `You are building a final-exam revision guide for the course "${courseTitle}", from the student's own topic pages.`,
      "",
      "You are given, below, an INDEX of every topic: its id, its exam weight (0–1, higher = more likely to be examined), its summary, and a digest of its notes, formulas, worked examples and open questions. Build the review from THIS material — you are consolidating and prioritising what the student already has, not inventing new content.",
      "",
      "How the exam weight drives the guide — this is the whole point of prioritising:",
      "- HIGH weight (roughly ≥ 0.6): a full section — condensed notes, its formulas, ONE worked example, and the pitfalls that lose marks. These are what the student spends their time on.",
      "- MID weight (roughly 0.35–0.6): a 'standard' section — condensed notes and formulas, but no worked example.",
      "- LOW weight (roughly < 0.35): a 'brief' section — two or three lines in `notes`, everything else empty. Do not pad a low-weight topic into a big section; doing so is the exact failure this weighting exists to prevent.",
      "Order the sections by weight, highest first, and set each section's `depth` to match its weight band.",
      "",
      "The four parts of the output:",
      "1. `sections` — one per topic, as above. Every section's `topicIds` is the id from the index, copied EXACTLY. It is the click-through target; an id you did not read from the index is discarded.",
      "2. `formulaSheet` — every formula across all topics, consolidated into one last-minute sheet. `latex` carries no $ delimiters. Carry each formula's topic id(s).",
      "3. `questionBank` — likely exam questions WITH answers, weighted toward the high-weight topics and matching the exam format below. A numeric question shows its working in the answer. Carry topic id(s).",
      "4. `weakSpots` — built from the topics' OPEN QUESTIONS and CONFLICTS in the index: the unresolved disagreements between sessions and the gaps the material never closed, each with what the student should do about it. If the index flags none, return an empty array — do not manufacture weak spots.",
      "",
      "Rules:",
      "- Write notes, answers and pitfalls as study material a student reads, not as descriptions of what such material would contain.",
      "- Inline math in `$…$`; display formulas in the formula sheet carry no delimiters (the sheet adds them).",
      "- Do not invent facts the topic pages do not support. This is a revision guide over the student's notes, and a confident fabrication is worse than an omission the night before an exam.",
      "",
      "EXAM FORMAT (what this course's exam looks like — shape the question bank to it):",
      "---",
      examFormat,
      "---",
      "",
      "TOPIC INDEX:",
      topicIndex,
    ].join("\n"),
});

export const EXAM_REVIEW_SYSTEM =
  "You are an experienced instructor writing a student's final-exam revision guide from their own topic notes. You prioritise ruthlessly by exam weight — deep on what matters, a couple of lines on what does not — consolidate the formulas and likely questions, and surface the unresolved conflicts in the material rather than papering over them. You consolidate what is there; you do not invent what is not.";
