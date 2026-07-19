/**
 * Completeness prompt templates (PLAN.md §AI Strategy §3; §5 *Completeness & coverage*
 * and *Step D*).
 *
 * Two prompts, two jobs, and the pairing between them and their models is load-bearing in
 * opposite directions — which is why both are documented here rather than left to `JOBS`.
 */

import { definePrompt } from "./define";

/* ────────────────────────────────────────────────────────────────────────── */
/* coverage-checklist                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠ **This is the one deliberate Gemini-over-Gemini pairing, and it is not a mistake.**
 *
 * `coverage-checklist` is pinned to `gemini-3.1-flash-lite`, the same family as
 * `topic-routing`. The cross-family critic rule says a critic must not share its
 * generator's blind spots — and the generator this call checks is **`topic-merge`, on
 * `claude-sonnet-5`**, because what it examines is the topic *pages*, which Sonnet wrote.
 * Routing merely decided which page a segment went to; it wrote none of the content this
 * call reads. So the pairing is cross-family where it counts.
 *
 * Do not "fix" this by re-pointing the job to Anthropic. That would put the checker on the
 * same family as the merger that produced the pages, which is the failure the rule exists
 * to prevent.
 */
export const coverageChecklistPrompt = definePrompt({
  id: "coverage-checklist",
  version: 1,
  description:
    "Extracts a syllabus's learning objectives and maps each to a covering topic page, or flags it as partially covered or missing — the importance oracle behind the coverage card's 'these 2 required topics have no page yet'.",
  render: ({
    courseTitle,
    topicIndex,
    syllabusText,
  }: {
    courseTitle: string;
    topicIndex: string;
    syllabusText: string;
  }) =>
    [
      `You are checking whether a student's notes for "${courseTitle}" cover what the course syllabus says they must learn.`,
      "",
      "Do this in two passes, in this order:",
      "",
      "1. Read the SYLLABUS and list the learning objectives it states — the things the course says a student will be able to do or will understand. Take the document's own wording. If the syllabus states objectives in a dedicated section, use those; if it states them scattered through the programme, gather them. Do NOT invent objectives, and do not turn the topic list back into objectives.",
      "2. For EACH objective, look through the TOPIC PAGES INDEX and decide whether a page teaches it fully, teaches part of it, or does not address it.",
      "",
      "Rules that decide whether this is useful or noise:",
      "- Be strict about 'full'. It means a student revising only from that page could do what the objective asks. If they would still have to go find something, that is 'partial'.",
      "- Be strict about 'none' too. A topic with a different NAME may still teach the objective — read the summary and key terms before concluding nothing covers it. Crying wolf about a covered objective is as damaging as missing an uncovered one, because it teaches the student to ignore this list.",
      "- Copy topic ids EXACTLY from the index. An id you did not read from the index is discarded, and the objective is then treated as uncovered.",
      "- A course whose syllabus states no objectives at all is a real and legitimate answer: return an empty list and say so in `notes`. Do not manufacture objectives from the schedule.",
      "",
      "TOPIC PAGES INDEX (what the student's notes currently contain):",
      topicIndex,
      "",
      "SYLLABUS:",
      "---",
      syllabusText,
      "---",
    ].join("\n"),
});

export const COVERAGE_CHECKLIST_SYSTEM =
  "You check a set of study notes against a course syllabus and report, objective by objective, what is covered and what is not. You are precise about ids, conservative about declaring something missing, and you never pad the list — a student acts on what you flag, so a false alarm costs them real revision time.";

/* ────────────────────────────────────────────────────────────────────────── */
/* deep-review-audit — Step D                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * §5 Step D: **an independent second reader, with a different objective.**
 *
 * Two properties make this worth ~$1 a document, and losing either makes it worthless:
 *
 * 1. **A different family from the extractor.** `doc-structuring` runs on
 *    `gemini-3.1-pro-preview`; this runs on `claude-opus-4-8`. A second pass on the same
 *    family re-reads the document with the same blind spots and confirms the first pass's
 *    omissions — the most expensive possible way to have no check.
 * 2. **A different question.** The extractor was asked "what does this document say?" and
 *    this is asked *"what must a student know from this material?"*. That is why the
 *    template below insists on working from the material first and consulting the topic
 *    index second. An audit that reads the pages and then looks for holes finds only the
 *    holes the pages already suggest; an audit that lists what matters and then checks
 *    finds the concept nobody wrote down — which is the entire point.
 */
export const deepReviewAuditPrompt = definePrompt({
  id: "deep-review-audit",
  version: 1,
  description:
    "An independent second reading of a document: lists the concepts a student must know from it and reconciles each against the topic pages already built, splitting findings into missing / refine / conflict / covered.",
  render: ({
    courseTitle,
    documentLabel,
    sessionLabel,
    topicIndex,
    material,
  }: {
    courseTitle: string;
    documentLabel: string;
    sessionLabel: string;
    topicIndex: string;
    material: string;
  }) =>
    [
      `You are the second reader on "${documentLabel}"${sessionLabel === "" ? "" : ` (${sessionLabel})`}, a document from the course "${courseTitle}".`,
      "",
      "Another system has already read this document and folded it into a set of topic pages. Your job is NOT to check its work on its own terms. Your job is to answer a different question, independently:",
      "",
      "**What must a student know from this material?**",
      "",
      "Work in this order, and the order matters:",
      "",
      "1. Read the MATERIAL below and build your own list of the concepts a student is expected to walk away knowing. Do this BEFORE looking at the topic index. If you read the pages first you will only find the gaps the pages themselves suggest, and the concept nobody wrote down — the one this whole review exists to catch — will be invisible to you.",
      "2. Only then, for each concept, find it in the TOPIC PAGES INDEX and give a verdict.",
      "",
      "Verdicts, and what each one costs:",
      "- **covered** — a page teaches this properly. This should be the answer for MOST concepts. A review that flags everything is a review a student stops reading.",
      "- **refine** — a page covers the concept but is missing something specific this material contains. Supply the missing study material in `markdown`, written as notes a student reads, not as a note to the system about what is missing.",
      "- **conflict** — a page states something this material contradicts. Say what the page claims and what the material says. **Do not assume you are right.** The page was built from this and other documents, and a later session legitimately refines an earlier one. A conflict is shown to the student to decide; it never overwrites the page.",
      "- **missing** — no page addresses this concept at all. Supply the study material in `markdown`; it becomes a new topic page.",
      "",
      "Rules:",
      "- Quote the material. Every finding carries a verbatim `evidence` quote and the page it is on. A finding without a quote is an opinion and a student cannot check it.",
      "- Copy topic ids EXACTLY from the index. An invented id is discarded along with the finding attached to it.",
      "- Name concepts as concepts. 'Price Elasticity of Demand', never 'Session 7 material' — a concept-shaped name is what lets a finding become a topic page that later sessions can add to.",
      "- Do not pad. Ten real findings beat forty, and a `covered` verdict is a real finding.",
      "",
      "TOPIC PAGES INDEX (what the student's notes currently contain):",
      topicIndex,
      "",
      "MATERIAL:",
      "---",
      material,
      "---",
    ].join("\n"),
});

export const DEEP_REVIEW_AUDIT_SYSTEM =
  "You are an experienced course instructor doing a completeness review of a student's notes against the source material. You read the material on its own terms first and form your own view of what matters, then check the notes against it. You quote rather than assert, you are honest about how much is already fine, and when the notes disagree with you, you surface the disagreement rather than assuming you are right.";
