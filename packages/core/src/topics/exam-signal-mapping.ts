/**
 * Mapping an instructor exam signal to the topic it is about (PLAN §9(a)).
 *
 * An `examSignal` is `{ quote, page, topic }` where `topic` is a **free-text label the model
 * wrote**, not a `topic_id` — so before §9(a) can feed the weight blend, each signal has to be
 * attached to a real topic. The decision (recorded in the Wave 7 plan) is **page-match first,
 * fuzzy fallback**:
 *
 *  1. **Page match.** A signal carries the document and page it was found on. The topic whose
 *     `topic_sources` locators cover that `(document, page)` is the one the lecturer was
 *     talking about when they said "this is on the exam" — location is far stronger evidence
 *     than a paraphrased label. Page numbers are per-document, so the match is scoped to the
 *     signal's own document; a page 12 in Lecture 3 must never match a topic fed by page 12 of
 *     Lecture 9.
 *  2. **Fuzzy fallback.** When no source covers the page — the page was skipped, or the topic
 *     was fed from a different document — the free-text label and the quote are matched against
 *     topic titles and summaries by token overlap. This is deliberately second: a label is the
 *     model's opinion about what a slide was about, and two topics can share vocabulary.
 *  3. **Unmapped.** A signal that matches no page and clears no fuzzy threshold is left
 *     unattached rather than forced onto the nearest topic. Misattributing a signal inflates
 *     the wrong topic's exam weight, which is worse than dropping it — a dropped signal costs a
 *     little accuracy, a misattributed one actively misleads revision.
 *
 * Pure and I/O-free: hand it the signals and the topics (with their source page-ranges) and it
 * returns one decision per signal.
 */

/** A single instructor exam signal, ready to map. `documentId` scopes the page match. */
export interface MappableSignal {
  /** The verbatim quote — used only as extra fuzzy-match surface. */
  readonly quote: string;
  /** The 1-based page/slide the signal was found on, within `documentId`. */
  readonly page: number;
  /** The model's free-text label for what the signal is about (`examSignal.topic`). */
  readonly label: string;
  /** The document the signal came from. Page numbers are per-document, so the match needs it. */
  readonly documentId: string;
}

/** One document's contribution to a topic, from `topic_sources.locators`. */
export interface TopicSourceRange {
  readonly documentId: string;
  /** The page/slide numbers this document fed the topic from. */
  readonly pages: readonly number[];
}

/** A topic, with enough to page-match and fuzzy-match against. */
export interface MappableTopic {
  readonly topicId: string;
  readonly title: string;
  readonly summary: string;
  readonly sources: readonly TopicSourceRange[];
}

/** How a signal found its topic — the audit trail behind the mapping. */
export type SignalMatchMethod = "page" | "fuzzy" | "unmapped";

export interface SignalMapping {
  readonly signal: MappableSignal;
  /** The topic the signal maps to, or `null` when nothing matched (never a guess). */
  readonly topicId: string | null;
  readonly method: SignalMatchMethod;
  /** The fuzzy score behind a `fuzzy` or disambiguated `page` match, for inspection/tests. */
  readonly score: number;
}

/**
 * The minimum token-overlap score a fuzzy match must clear to be trusted. Below it, a signal
 * is left `unmapped` rather than attached to the least-bad topic — the whole point of the
 * threshold is that "no good match" is a real answer.
 */
export const FUZZY_MATCH_THRESHOLD = 0.18;

/** Word tokens, lowercased, past a length that drops articles and other noise words. */
function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3);
  return new Set(tokens);
}

/**
 * Token-overlap similarity between the signal's text and a topic's text, in `[0, 1]`.
 *
 * The denominator is the signal's own token count, not the union: a short label matching a few
 * of a long summary's terms should still score well, because the label is what the lecturer's
 * pointer was *about*, and a topic summary is legitimately much longer than a label.
 */
function fuzzyScore(signalTokens: Set<string>, topic: MappableTopic): number {
  if (signalTokens.size === 0) return 0;
  const topicTokens = tokenize(`${topic.title} ${topic.summary}`);
  if (topicTokens.size === 0) return 0;

  let shared = 0;
  for (const token of signalTokens) {
    if (topicTokens.has(token)) shared += 1;
  }
  return shared / signalTokens.size;
}

/** The best-scoring topic among `candidates` for one signal, and its score. */
function bestFuzzy(
  signal: MappableSignal,
  candidates: readonly MappableTopic[],
): { topic: MappableTopic | null; score: number } {
  const signalTokens = tokenize(`${signal.label} ${signal.quote}`);
  let best: MappableTopic | null = null;
  let bestScore = 0;
  for (const topic of candidates) {
    const score = fuzzyScore(signalTokens, topic);
    // Strictly greater keeps the FIRST topic on a tie, which — given a stable input order —
    // makes the mapping deterministic rather than dependent on iteration accidents.
    if (score > bestScore) {
      best = topic;
      bestScore = score;
    }
  }
  return { topic: best, score: bestScore };
}

/** Whether a topic was fed the signal's page, within the signal's own document. */
function coversPage(topic: MappableTopic, signal: MappableSignal): boolean {
  return topic.sources.some(
    (source) => source.documentId === signal.documentId && source.pages.includes(signal.page),
  );
}

/** Maps one signal to a topic, page-first then fuzzy, or leaves it unmapped. */
export function mapExamSignal(
  signal: MappableSignal,
  topics: readonly MappableTopic[],
): SignalMapping {
  // 1. Page match, scoped to the signal's document.
  const pageMatches = topics.filter((topic) => coversPage(topic, signal));
  if (pageMatches.length === 1) {
    const topic = pageMatches[0];
    if (topic !== undefined) return { signal, topicId: topic.topicId, method: "page", score: 1 };
  }
  if (pageMatches.length > 1) {
    // A page can feed several topics. Disambiguate by label/quote overlap, but this is still a
    // page hit — the location already established which document and page the lecturer meant.
    const { topic, score } = bestFuzzy(signal, pageMatches);
    const chosen = topic ?? pageMatches[0];
    if (chosen !== undefined) return { signal, topicId: chosen.topicId, method: "page", score };
  }

  // 2. Fuzzy fallback across all topics.
  const { topic, score } = bestFuzzy(signal, topics);
  if (topic !== null && score >= FUZZY_MATCH_THRESHOLD) {
    return { signal, topicId: topic.topicId, method: "fuzzy", score };
  }

  // 3. Unmapped — deliberately not attached to the nearest topic.
  return { signal, topicId: null, method: "unmapped", score };
}

/** Maps every signal, returning one decision each — the input to the §9(a) signal term. */
export function mapExamSignals(
  signals: readonly MappableSignal[],
  topics: readonly MappableTopic[],
): readonly SignalMapping[] {
  return signals.map((signal) => mapExamSignal(signal, topics));
}

/**
 * `topicId → number of signals mapped to it`, the per-topic count `computeExamWeight` reads
 * for its §9(a) term. Unmapped signals contribute to no topic, exactly as intended.
 */
export function countSignalsByTopic(
  mappings: readonly SignalMapping[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const mapping of mappings) {
    if (mapping.topicId === null) continue;
    counts.set(mapping.topicId, (counts.get(mapping.topicId) ?? 0) + 1);
  }
  return counts;
}
