/**
 * PPTX → PDF conversion via CloudConvert (PLAN §4.2, the visual path).
 *
 * ## Why this is a first-class route and not a fallback
 *
 * PLAN's 🔴 measured block of 2026-07-18: four of five Marketing decks yield 22–39 words
 * per slide, i.e. their content is in the images. For a course like Marketing this is not
 * an "auto-upgrade for image-heavy decks", it is simply *the* path. The text branch on
 * those decks produces mostly-empty topic pages, which is the outcome the measurement
 * exists to prevent.
 *
 * ## Tasks, not jobs — because of the token's scopes
 *
 * The API key is scoped `task.read` + `task.write` and deliberately nothing else, so the
 * `/v2/jobs` endpoints are unavailable. That is fine: CloudConvert lets tasks be created
 * individually and chained by referencing the previous task's id, which is what this does —
 * `import/upload` → `convert` → `export/url`.
 *
 * ## Polling, deliberately, and inside the Inngest step
 *
 * The obvious alternative is a webhook, and it is the wrong one here twice over. It would
 * need a **public, non-GET** endpoint, and the access-code gate may only ever exempt
 * GET-only route handlers — `/api/inngest` is the one documented exception and it is not
 * going to be the second. And the token cannot create one anyway: registering a webhook
 * needs `webhook.write`, which was not granted. So the step polls, which is also the
 * simpler thing to reason about: Vercel Pro allows 800 s functions and a deck converts in
 * well under a minute, so the wait is comfortably inside one step's budget.
 *
 * Every response is parsed with Zod before use. An external API is a boundary like any
 * other, and this one hands back URLs that we then fetch bytes from.
 */

import { z } from "zod";

const API_BASE = "https://api.cloudconvert.com/v2";

/**
 * How long to wait for a conversion before giving up.
 *
 * A 45-slide, 38 MB deck is the worst case in the corpus. Two minutes is several times
 * that, and still an order of magnitude below the 800 s function ceiling — the bound
 * exists so a stuck CloudConvert task fails this step and lets Inngest retry, rather than
 * holding a function open until the platform kills it with no diagnostic.
 */
const CONVERSION_TIMEOUT_MS = 120_000;
/** Poll interval. Conversions take seconds, so this is responsive without being chatty. */
const POLL_INTERVAL_MS = 2_000;

/** A conversion that failed for a reason retrying will not fix. */
export class CloudConvertError extends Error {
  constructor(
    message: string,
    readonly retriable: boolean,
  ) {
    super(message);
    this.name = "CloudConvertError";
  }
}

// ── Response shapes ───────────────────────────────────────────────────────────

const uploadFormSchema = z.object({
  url: z.url(),
  parameters: z.record(z.string(), z.string()),
});

const importTaskSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    result: z.object({ form: uploadFormSchema }),
  }),
});

const createdTaskSchema = z.object({ data: z.object({ id: z.string().min(1) }) });

/**
 * A polled task.
 *
 * `result.files` is present only once `status` is `finished`, which is why it is optional
 * here rather than being asserted after the status check — the schema describes what the
 * API actually returns at every stage, and the code narrows.
 */
const polledTaskSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    status: z.enum(["waiting", "processing", "finished", "error"]),
    message: z.string().nullish(),
    code: z.string().nullish(),
    result: z
      .object({
        files: z.array(z.object({ filename: z.string().nullish(), url: z.url() })).optional(),
      })
      .nullish(),
  }),
});

export interface ConvertPptxOptions {
  readonly apiKey: string;
  readonly pptxBytes: Uint8Array;
  readonly filename: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable so tests do not actually wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ConvertPptxResult {
  readonly pdfBytes: Uint8Array;
  /** Wall-clock for the whole conversion, for the cost/latency report. */
  readonly elapsedMs: number;
}

/**
 * Converts a `.pptx` to a PDF and returns the bytes.
 *
 * Throws `CloudConvertError`. `retriable` distinguishes "CloudConvert was briefly unwell"
 * (let Inngest retry) from "this file cannot be converted" (do not burn the retry budget) —
 * the caller maps that onto `NonRetriableError`.
 */
export async function convertPptxToPdf({
  apiKey,
  pptxBytes,
  filename,
  fetchImpl,
  sleep,
}: ConvertPptxOptions): Promise<ConvertPptxResult> {
  const doFetch = fetchImpl ?? fetch;
  const wait = sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = Date.now();

  const post = async (path: string, body: unknown): Promise<unknown> => {
    const response = await doFetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      // Only 429 and 5xx are worth another attempt. A 401/403 means the key or its scopes
      // are wrong and a 4xx means the request was, and retrying either just spends the
      // budget three times to learn the same thing.
      throw new CloudConvertError(
        `CloudConvert ${path} returned ${response.status}.`,
        response.status === 429 || response.status >= 500,
      );
    }
    return await response.json();
  };

  // ── 1. Create an upload slot ────────────────────────────────────────────────
  const importTask = importTaskSchema.parse(await post("/import/upload", {}));
  const { url: formUrl, parameters } = importTask.data.result.form;

  // ── 2. Upload the bytes to it ───────────────────────────────────────────────
  const form = new FormData();
  for (const [key, value] of Object.entries(parameters)) form.append(key, value);
  // The file field must be appended LAST — the storage backend behind the signed form
  // ignores parameters that arrive after the file part.
  form.append(
    "file",
    new Blob([pptxBytes.slice().buffer], {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }),
    filename,
  );

  const uploadResponse = await doFetch(formUrl, { method: "POST", body: form });
  if (!uploadResponse.ok) {
    throw new CloudConvertError(
      `Uploading the deck to CloudConvert returned ${uploadResponse.status}.`,
      uploadResponse.status >= 500 || uploadResponse.status === 429,
    );
  }

  // ── 3. Convert, then 4. expose the result as a URL ──────────────────────────
  const convertTask = createdTaskSchema.parse(
    await post("/convert", {
      input: importTask.data.id,
      input_format: "pptx",
      output_format: "pdf",
    }),
  );
  const exportTask = createdTaskSchema.parse(
    await post("/export/url", { input: convertTask.data.id }),
  );

  // ── 5. Poll, inside this step ───────────────────────────────────────────────
  let fileUrl: string | null = null;
  while (Date.now() - startedAt < CONVERSION_TIMEOUT_MS) {
    await wait(POLL_INTERVAL_MS);

    const response = await doFetch(`${API_BASE}/tasks/${exportTask.data.id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      // A blip mid-poll is not a failed conversion. Keep polling until the deadline.
      if (response.status >= 500 || response.status === 429) continue;
      throw new CloudConvertError(
        `Polling the CloudConvert task returned ${response.status}.`,
        false,
      );
    }

    const polled = polledTaskSchema.parse(await response.json());
    if (polled.data.status === "error") {
      throw new CloudConvertError(
        `CloudConvert could not convert this deck: ${polled.data.message ?? polled.data.code ?? "no reason given"}.`,
        false,
      );
    }
    if (polled.data.status === "finished") {
      const first = polled.data.result?.files?.[0];
      if (first === undefined) {
        throw new CloudConvertError("CloudConvert finished but produced no file.", false);
      }
      fileUrl = first.url;
      break;
    }
  }

  if (fileUrl === null) {
    throw new CloudConvertError(
      `CloudConvert did not finish within ${CONVERSION_TIMEOUT_MS / 1000}s.`,
      true,
    );
  }

  // ── 6. Fetch the PDF ────────────────────────────────────────────────────────
  const pdfResponse = await doFetch(fileUrl);
  if (!pdfResponse.ok) {
    throw new CloudConvertError(
      `Downloading the converted PDF returned ${pdfResponse.status}.`,
      pdfResponse.status >= 500,
    );
  }

  return {
    pdfBytes: new Uint8Array(await pdfResponse.arrayBuffer()),
    elapsedMs: Date.now() - startedAt,
  };
}
