/**
 * The `chunk-and-embed` step (PLAN "Document & Notes Pipeline" §6, M1 item 5e).
 *
 * Chunk the document along its structure, embed what is new, write `document_chunks`. Then
 * do the same for the **topic pages** this document just changed, so that search covers the
 * synthesized notes and not only the raw slides.
 *
 * The deterministic half is entirely in `@study/core` (`chunkDocument`, `chunkTopicPage`)
 * and is unit-tested there. What lives here is the part that touches the world: hashing,
 * reuse, rate limits, persistence, and the one rule that governs all of them.
 *
 * ## The rule: **an embedding failure degrades to `partial`, never to `failed`**
 *
 * PLAN §7 is explicit — "Embedding failures also degrade to `partial` — the topic pages are
 * readable even when search indexing lags." That is the whole point of doing this after the
 * merge rather than before it. By the time this step runs, the student's topic pages already
 * exist and are readable; all that is at stake is whether search finds them *today*. So
 * every failure path in this module writes chunk rows with a null `embedding` and reports
 * `degraded: true`. Nothing in here throws on an embedding problem. The rows are written
 * regardless precisely so that a later run can fill them in without re-chunking.
 *
 * ## Voyage rate limits, measured
 *
 * 🔴 **Voyage 429s this account after three requests in about fourteen seconds.** That was
 * measured in Wave 4 on the *routing* path, which embeds a handful of segments. This step
 * embeds a whole document and is therefore the first caller that can plausibly make dozens
 * of requests, so "effectively free" is the wrong mental model — the binding constraint is
 * requests per minute, not dollars.
 *
 * Three mitigations, in order of how much they actually buy:
 *
 * 1. **Reuse by `chunk_hash` (biggest).** Every chunk's vector is looked up before anything
 *    is sent. A re-processed document, or a re-run of this step after a transient failure,
 *    makes **zero** embedding requests. Since a retry is exactly when a rate limit is most
 *    likely to still be in force, this removes the request storm from the case that would
 *    otherwise cause it.
 * 2. **Pacing.** Requests are issued one batch at a time with {@link PACE_DELAY_MS} between
 *    them, rather than in a tight loop. {@link EMBED_BATCH_SIZE} is large enough that an
 *    ordinary 40-slide deck is one or two requests.
 * 3. **Bounded backoff inside the client.** Already built by Wave 4: a 429 is retried up to
 *    four times with doubling delay, and — importantly — **intermediate retries emit no
 *    `ai_generations` row**. Only a batch that exhausts all four attempts writes an unpriced
 *    row.
 *
 * ### On `UNPRICED_TOLERANCE`
 *
 * The guard steps its posture up once a month accumulates more than five `cost_usd = NULL`
 * rows, and one of the five is already spent on Wave 4's Voyage 429. The question asked of
 * this step was whether it can burn the rest on a single large document. It cannot, and the
 * reason is the emission rule above: an unpriced row requires a batch to fail **four
 * consecutive attempts across ~7 s of backoff**, and with reuse plus pacing a large document
 * is a small number of batches to begin with. The realistic bad day is one unpriced row, not
 * five. This is a bound rather than a guarantee — a total Voyage outage during a 200-batch
 * textbook would exceed it — so the step also *stops embedding* after
 * {@link MAX_BATCH_FAILURES} failed batches and degrades the rest, rather than marching
 * through the whole document writing an unpriced row per batch. That cap is what makes the
 * bound hold regardless of document size.
 */

import type { EmbeddingClient } from "@study/ai";
import { sha256Hex, storedExtractionSchema, storedTopicPageSchema } from "@study/ai";
import {
  type Chunk,
  type ChunkLocator,
  chunkDocument,
  chunkTopicPage,
  normalizeForHash,
  structureForKind,
  type TopicPageSection,
} from "@study/core";
import type { SupabaseAdminClient, TablesInsert } from "@study/db";
import { logProcessingEvent, setDocumentStatus } from "@/inngest/documents";
import { createStudyEmbeddingClient, parseStoredVector, toStoredVector } from "@/lib/ai/embeddings";

/**
 * Inputs per Voyage request.
 *
 * Below the client's own default of 96, deliberately. A 40-slide deck chunks to roughly
 * 40–60 chunks, so 48 makes that one or two requests — and a smaller request is a smaller
 * thing to lose and re-send when one does get rate-limited.
 */
export const EMBED_BATCH_SIZE = 48;

/** Gap between consecutive embedding requests. See the rate-limit note above. */
export const PACE_DELAY_MS = 1_200;

/**
 * How many batches may fail before the step stops trying and degrades the remainder.
 *
 * Two, not one: a single failure is bad luck and the next batch usually succeeds, while two
 * means Voyage is refusing us rather than hiccupping. Bounding it here is what keeps a
 * pathological document from writing an unpriced `ai_generations` row per batch and walking
 * the §6 guard's `UNPRICED_TOLERANCE` (5) on its own.
 */
export const MAX_BATCH_FAILURES = 2;

export interface ChunkAndEmbedInput {
  readonly admin: SupabaseAdminClient;
  readonly userId: string;
  readonly documentId: string;
  readonly courseId: string;
  /** `documents.kind` — decides slide-per-page versus heading-section chunking. */
  readonly kind: string;
  readonly filename: string;
  /** The topics this document just touched, for the synthesized `topic_page` chunks. */
  readonly topicIds: readonly string[];
}

export interface ChunkAndEmbedSummary {
  readonly documentChunks: number;
  readonly topicChunks: number;
  /** Vectors carried over from a previous run rather than re-billed. */
  readonly reused: number;
  readonly embedded: number;
  /** Chunks written with a null embedding — searchable only after a later run. */
  readonly unembedded: number;
  /** True when anything at all was written without a vector. Feeds §7's `partial`. */
  readonly degraded: boolean;
  readonly costUsd: number;
  readonly elapsedMs: number;
}

/** `setTimeout` as a promise. See the identical note in `packages/ai/src/embeddings.ts`. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => unknown }).setTimeout(
      resolve,
      ms,
    );
  });
}

/**
 * A locator, rendered into the string the hash covers.
 *
 * Written by hand rather than `JSON.stringify`, because key order in a serialized object is
 * an implementation detail and this string is a database key. Two runs that produced
 * `{page:3,part:1}` and `{part:1,page:3}` must hash identically or every re-run re-embeds
 * the whole document and duplicates every row.
 */
export function locatorKey(locator: ChunkLocator): string {
  if ("page" in locator) {
    return `p:${locator.page}:${locator.toPage ?? locator.page}:${locator.part ?? 0}`;
  }
  return `t:${locator.topicId}:${locator.section}:${locator.part ?? 0}`;
}

/**
 * `chunk_hash` — sha256 over the locator **and** the normalized content.
 *
 * The locator is in the hash so that a deck which repeats a slide verbatim keeps both
 * citations instead of being deduplicated down to one by the unique index. See the long
 * note in `20260719215804_chunk_identity_and_immutable_exam_reviews.sql`.
 */
export function chunkHash(chunk: Chunk): Promise<string> {
  return sha256Hex(`${locatorKey(chunk.locator)}\n${normalizeForHash(chunk.content)}`);
}

/** A chunk plus the two things the database needs that the pure chunker cannot compute. */
interface HashedChunk {
  readonly chunk: Chunk;
  readonly hash: string;
  readonly source: "document" | "topic_page";
  readonly topicId: string | null;
}

async function hashAll(
  chunks: readonly Chunk[],
  source: "document" | "topic_page",
  topicId: string | null,
): Promise<HashedChunk[]> {
  return Promise.all(
    chunks.map(async (chunk) => ({ chunk, hash: await chunkHash(chunk), source, topicId })),
  );
}

/**
 * Vectors already stored for these hashes, for this user.
 *
 * Scoped by `user_id` and not by document: an identical chunk in another of the user's
 * documents is the same text and its vector is equally valid, so a re-uploaded deck shared
 * between two courses embeds once. Never scoped wider than the user — a vector is derived
 * from their content and must not cross a tenant boundary even though doing so would be
 * mathematically harmless.
 */
async function loadExistingVectors(
  admin: SupabaseAdminClient,
  userId: string,
  hashes: readonly string[],
): Promise<Map<string, number[]>> {
  const found = new Map<string, number[]>();
  if (hashes.length === 0) return found;

  // Chunked because a `in.(…)` list becomes a URL, and a 600-page book's worth of 64-char
  // hashes would exceed what PostgREST accepts in one query string.
  const LOOKUP_BATCH = 200;
  for (let i = 0; i < hashes.length; i += LOOKUP_BATCH) {
    const slice = hashes.slice(i, i + LOOKUP_BATCH);
    const { data, error } = await admin
      .from("document_chunks")
      .select("chunk_hash, embedding")
      .eq("user_id", userId)
      .in("chunk_hash", slice)
      .not("embedding", "is", null);

    // A failed lookup is not a failure: it means nothing is reused and everything is
    // embedded, which is more expensive but entirely correct.
    if (error !== null || data === null) continue;

    for (const row of data) {
      if (found.has(row.chunk_hash)) continue;
      const vector = parseStoredVector(row.embedding);
      if (vector !== null) found.set(row.chunk_hash, vector);
    }
  }
  return found;
}

/**
 * Embeds the chunks that have no stored vector, paced and bounded.
 *
 * Returns a map rather than throwing on failure. Everything about this function's shape is
 * the "degrade, never fail" rule: a batch that fails leaves its chunks out of the map, the
 * caller writes those rows with a null embedding, and the document ends `partial`.
 */
async function embedMissing(input: {
  readonly embeddings: EmbeddingClient;
  readonly admin: SupabaseAdminClient;
  readonly userId: string;
  readonly documentId: string;
  readonly courseId: string;
  readonly missing: readonly HashedChunk[];
}): Promise<{ vectors: Map<string, readonly number[]>; costUsd: number; failures: number }> {
  const vectors = new Map<string, readonly number[]>();
  let costUsd = 0;
  let failures = 0;

  const batches: HashedChunk[][] = [];
  for (let i = 0; i < input.missing.length; i += EMBED_BATCH_SIZE) {
    batches.push([...input.missing.slice(i, i + EMBED_BATCH_SIZE)]);
  }

  for (const [index, batch] of batches.entries()) {
    if (failures >= MAX_BATCH_FAILURES) {
      // Stop rather than march on. See the `UNPRICED_TOLERANCE` note in the module header:
      // continuing would write one unpriced metering row per remaining batch and could walk
      // the §6 guard's whole tolerance on a single document.
      await logProcessingEvent(input.admin, {
        userId: input.userId,
        documentId: input.documentId,
        courseId: input.courseId,
        step: "embed",
        level: "warn",
        detail: `Search indexing stopped early after ${failures} failed attempts. Your topic pages are complete and readable; the rest of this document will be indexed the next time it is processed.`,
      });
      break;
    }

    // Pace. The first batch goes immediately — a document that needs only one request
    // should not pay a second of latency for a rate limit it will never reach.
    if (index > 0) await sleep(PACE_DELAY_MS);

    try {
      const result = await input.embeddings.embed({
        texts: batch.map((entry) => entry.chunk.content),
        inputType: "document",
        purpose: "embed-chunk",
      });
      costUsd += result.costUsd;

      // Pairing is positional and the client guarantees order and length — it throws rather
      // than returning a short batch, precisely so this loop cannot silently shift every
      // vector onto the wrong chunk.
      batch.forEach((entry, position) => {
        const vector = result.embeddings[position];
        if (vector !== undefined) vectors.set(entry.hash, vector);
      });
    } catch (error) {
      failures += 1;
      console.error(
        `[chunk-and-embed] batch ${index + 1}/${batches.length} failed for document ${input.documentId}:`,
        error,
      );
    }
  }

  return { vectors, costUsd, failures };
}

/**
 * A `document_chunks` row, ready to insert.
 *
 * Typed as the generated `TablesInsert<"document_chunks">` rather than as a loose record,
 * so a column renamed in a migration breaks here at compile time instead of at runtime as a
 * PostgREST "column does not exist" inside a background job nobody is watching.
 *
 * `locator` is spread into a plain object for the reason `coverageToJson` spells out: the
 * pure chunker's `ChunkLocator` is a readonly union and the column's type is `Json`, which
 * is mutable. Spreading is the honest conversion; a cast would compile and hide the fact
 * that these are two different types meeting at a boundary.
 */
function toChunkRow(input: {
  readonly userId: string;
  readonly courseId: string;
  readonly documentId: string;
  readonly entry: HashedChunk;
  readonly vector: readonly number[] | undefined;
}): TablesInsert<"document_chunks"> {
  const { entry } = input;
  return {
    user_id: input.userId,
    course_id: input.courseId,
    // `document_chunks_owner` requires exactly the right one of these to be set per source.
    document_id: entry.source === "document" ? input.documentId : null,
    topic_id: entry.topicId,
    source: entry.source,
    content: entry.chunk.content,
    chunk_hash: entry.hash,
    token_count: entry.chunk.tokenCount,
    locator: { ...entry.chunk.locator },
    embedding: input.vector === undefined ? null : toStoredVector(input.vector),
  };
}

/**
 * Replaces a set of chunks wholesale.
 *
 * Delete-then-insert rather than upsert, and the reason is PostgREST rather than taste:
 * `on conflict` inference cannot name a **partial** unique index, and the two indexes that
 * close Gate 1 F4 are partial by necessity (`document_id` is null on a topic-page chunk and
 * `topic_id` is null on a document chunk, and NULLs never conflict). A full replace is
 * idempotent by construction and needs no inference at all.
 *
 * The delete happens **after** all the expensive work, so the window in which a crash leaves
 * a document with no chunks is two statements wide rather than the length of an embedding
 * run. Chunks are derived data — a re-run rebuilds them, and with reuse it rebuilds them
 * without spending anything — so that window costs a re-index, never content.
 */
async function replaceChunks(input: {
  readonly admin: SupabaseAdminClient;
  readonly userId: string;
  readonly courseId: string;
  readonly documentId: string;
  readonly entries: readonly HashedChunk[];
  readonly vectors: Map<string, readonly number[]>;
  readonly scope:
    | { readonly source: "document" }
    | { readonly source: "topic_page"; readonly topicId: string };
}): Promise<void> {
  const deletion = input.admin
    .from("document_chunks")
    .delete()
    .eq("user_id", input.userId)
    .eq("source", input.scope.source);

  const { error: deleteError } =
    input.scope.source === "document"
      ? await deletion.eq("document_id", input.documentId)
      : await deletion.eq("topic_id", input.scope.topicId);

  if (deleteError !== null) {
    throw new Error(`Could not clear old chunks: ${deleteError.message}`);
  }

  if (input.entries.length === 0) return;

  // Deduplicate by hash before inserting. The chunker can legitimately emit two identical
  // chunks — overlap between split pieces of two adjacent identical pages — and the unique
  // index would reject the whole INSERT rather than the one row.
  const seen = new Set<string>();
  const rows = input.entries
    .filter((entry) => {
      if (seen.has(entry.hash)) return false;
      seen.add(entry.hash);
      return true;
    })
    .map((entry) =>
      toChunkRow({
        userId: input.userId,
        courseId: input.courseId,
        documentId: input.documentId,
        entry,
        vector: input.vectors.get(entry.hash),
      }),
    );

  const INSERT_BATCH = 100;
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const { error } = await input.admin
      .from("document_chunks")
      .insert(rows.slice(i, i + INSERT_BATCH));
    if (error !== null) throw new Error(`Could not write chunks: ${error.message}`);
  }
}

/**
 * Turns a stored topic page into the sections that get embedded.
 *
 * Section ids are **content-derived, never positional**: `note:<block id>` rather than
 * `note:3`. A positional id would change every time the merger reordered the page, which
 * would change the locator, which would change the hash — and every topic-page chunk would
 * be re-embedded on every merge, for no change in content.
 */
export function topicPageSections(page: unknown): TopicPageSection[] {
  const parsed = storedTopicPageSchema.safeParse(page);
  if (!parsed.success) return [];
  const value = parsed.data;

  const sections: TopicPageSection[] = [];

  if (value.summary.trim() !== "") {
    sections.push({ section: "summary", heading: "Summary", markdown: value.summary });
  }

  for (const block of value.notes) {
    sections.push({
      section: `note:${block.id}`,
      heading: block.heading,
      markdown: block.markdown,
    });
  }

  if (value.keyTerms.length > 0) {
    sections.push({
      section: "keyTerms",
      heading: "Key terms",
      markdown: value.keyTerms.map((term) => `**${term.term}** — ${term.definition}`).join("\n\n"),
    });
  }

  if (value.formulas.length > 0) {
    sections.push({
      section: "formulas",
      heading: "Formulas",
      markdown: value.formulas
        .map((formula) => `**${formula.name}**\n\n$$${formula.latex}$$\n\n${formula.explanation}`)
        .join("\n\n"),
    });
  }

  for (const [index, example] of value.workedExamples.entries()) {
    sections.push({
      // Worked examples have no stable id of their own in the schema, so this one locator IS
      // positional. Stated rather than hidden: reordering them re-embeds them, which is a
      // few cents on a rare event and not worth inventing an id the merger cannot maintain.
      section: `example:${index + 1}`,
      heading: "Worked example",
      markdown: `${example.problem}\n\n${example.solution}`,
    });
  }

  return sections;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The step body                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

export async function runChunkAndEmbed(input: ChunkAndEmbedInput): Promise<ChunkAndEmbedSummary> {
  const { admin, userId, documentId, courseId } = input;
  const startedAt = Date.now();

  await setDocumentStatus(admin, documentId, userId, { status: "embedding" });
  await logProcessingEvent(admin, {
    userId,
    documentId,
    courseId,
    step: "embed",
    detail: "Indexing for search.",
  });

  // ── The document's own chunks ─────────────────────────────────────────────
  const { data: row, error } = await admin
    .from("documents")
    .select("extraction")
    .eq("id", documentId)
    .eq("user_id", userId)
    .single();

  if (error) throw new Error(`Could not read the extraction for ${documentId}: ${error.message}`);

  // Boundary rule: through the schema, never through a cast.
  const parsed = storedExtractionSchema.safeParse(row.extraction);
  if (!parsed.success) {
    throw new Error(
      `documents.extraction for ${documentId} did not match storedExtractionSchema: ${parsed.error.message}`,
    );
  }
  const stored = parsed.data;

  const documentChunks = chunkDocument({
    pages: stored.extraction.pages,
    headings: stored.extraction.headings,
    structure: structureForKind(input.kind),
  });

  // ── The topic pages this document changed (§6's synthesized chunks) ───────
  const topicSections = new Map<string, TopicPageSection[]>();
  if (input.topicIds.length > 0) {
    const { data: topicRows } = await admin
      .from("topics")
      .select("id, page")
      .eq("user_id", userId)
      .eq("course_id", courseId)
      .in("id", [...input.topicIds]);

    for (const topic of topicRows ?? []) {
      topicSections.set(topic.id, topicPageSections(topic.page));
    }
  }

  const hashedDocument = await hashAll(documentChunks, "document", null);
  const hashedTopics = new Map<string, HashedChunk[]>();
  for (const [topicId, sections] of topicSections) {
    hashedTopics.set(
      topicId,
      await hashAll(chunkTopicPage({ topicId, sections }), "topic_page", topicId),
    );
  }

  const all = [...hashedDocument, ...[...hashedTopics.values()].flat()];
  if (all.length === 0) {
    return {
      documentChunks: 0,
      topicChunks: 0,
      reused: 0,
      embedded: 0,
      unembedded: 0,
      degraded: false,
      costUsd: 0,
      elapsedMs: Date.now() - startedAt,
    };
  }

  // ── Reuse, then embed only what is genuinely new ──────────────────────────
  const uniqueHashes = [...new Set(all.map((entry) => entry.hash))];
  const existing = await loadExistingVectors(admin, userId, uniqueHashes);

  const vectors = new Map<string, readonly number[]>(existing);
  const missing = all.filter(
    (entry, index, list) =>
      !vectors.has(entry.hash) && list.findIndex((other) => other.hash === entry.hash) === index,
  );

  const embeddings = createStudyEmbeddingClient({
    userId,
    batchSize: EMBED_BATCH_SIZE,
    // A longer first backoff than the client's default second. The measured limit is a
    // request-rate one, and waiting two seconds is cheaper than a failed batch that costs a
    // chunk its vector and the guard one of its five unpriced rows.
    retryDelayMs: 2_000,
  });

  const embedded = await embedMissing({
    embeddings,
    admin,
    userId,
    documentId,
    courseId,
    missing,
  });
  for (const [hash, vector] of embedded.vectors) vectors.set(hash, vector);

  // ── Persist ───────────────────────────────────────────────────────────────
  await replaceChunks({
    admin,
    userId,
    courseId,
    documentId,
    entries: hashedDocument,
    vectors,
    scope: { source: "document" },
  });

  for (const [topicId, entries] of hashedTopics) {
    await replaceChunks({
      admin,
      userId,
      courseId,
      documentId,
      entries,
      vectors,
      scope: { source: "topic_page", topicId },
    });
  }

  const topicChunkCount = [...hashedTopics.values()].reduce(
    (total, list) => total + list.length,
    0,
  );
  const unembedded = all.filter((entry) => !vectors.has(entry.hash)).length;
  const degraded = unembedded > 0;

  await logProcessingEvent(admin, {
    userId,
    documentId,
    courseId,
    step: "embed",
    level: degraded ? "warn" : "info",
    detail: degraded
      ? `Indexed ${all.length - unembedded} of ${all.length} passages. Your notes are complete and readable; ${unembedded} passage${unembedded === 1 ? "" : "s"} will be searchable after the next run.`
      : `Indexed ${hashedDocument.length} passage${hashedDocument.length === 1 ? "" : "s"} from this file${
          topicChunkCount === 0 ? "" : ` and ${topicChunkCount} from your topic pages`
        }${embedded.vectors.size === 0 && existing.size > 0 ? " (reused from a previous run)" : ""}.`,
  });

  return {
    documentChunks: hashedDocument.length,
    topicChunks: topicChunkCount,
    reused: all.filter((entry) => existing.has(entry.hash)).length,
    embedded: embedded.vectors.size,
    unembedded,
    degraded,
    costUsd: embedded.costUsd,
    elapsedMs: Date.now() - startedAt,
  };
}
