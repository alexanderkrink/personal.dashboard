import { describe, expect, it } from "vitest";
import { feedFingerprint, maskFeedUrl, redactSecrets } from "./secret";

/** Shaped like the real thing: the whole path is the capability token. */
const FEED_URL = "https://calendar.ie.edu/agenda/9f3c1d7ae4b8425fa0c6e21d5b7f8a03.ics";
const TOKEN = "9f3c1d7ae4b8425fa0c6e21d5b7f8a03";

describe("maskFeedUrl", () => {
  it("keeps the origin and hides the entire path", () => {
    const masked = maskFeedUrl(FEED_URL);
    expect(masked).toBe("https://calendar.ie.edu/••••••••");
  });

  it("leaks no byte of the token", () => {
    expect(maskFeedUrl(FEED_URL)).not.toContain(TOKEN);
    // Not even a fragment of it — a four-character tail is still token bytes.
    expect(maskFeedUrl(FEED_URL)).not.toContain(TOKEN.slice(-4));
  });

  it("hides the query string, where other feeds put the token", () => {
    const masked = maskFeedUrl(`https://example.edu/cal?key=${TOKEN}`);
    expect(masked).not.toContain(TOKEN);
    expect(masked).toBe("https://example.edu/••••••••");
  });

  it("degrades to a bare mask rather than echoing an unparseable value", () => {
    // Someone pasting a naked token into the URL box must not see it rendered
    // back at them as if it were safe.
    expect(maskFeedUrl(TOKEN)).toBe("••••••••");
    expect(maskFeedUrl("")).toBe("••••••••");
  });
});

describe("feedFingerprint", () => {
  it("is stable and distinguishes two feeds", () => {
    expect(feedFingerprint(FEED_URL)).toBe(feedFingerprint(FEED_URL));
    expect(feedFingerprint(FEED_URL)).not.toBe(feedFingerprint(`${FEED_URL}x`));
  });

  it("reveals nothing about the token", () => {
    const print = feedFingerprint(FEED_URL);
    expect(print).toHaveLength(6);
    expect(FEED_URL).not.toContain(print);
  });
});

describe("redactSecrets", () => {
  it("removes an exact known secret", () => {
    const message = `Failed to fetch ${FEED_URL}: 500`;
    expect(redactSecrets(message, [FEED_URL])).not.toContain(TOKEN);
  });

  it("removes a URL nobody told it about", () => {
    // The case that matters: an error from code that never knew it held a
    // secret. Redaction has to work on shape, not only on known values.
    const message = `request to https://calendar.ie.edu/agenda/${TOKEN}.ics failed, reason: ETIMEDOUT`;
    const scrubbed = redactSecrets(message, []);
    expect(scrubbed).not.toContain(TOKEN);
    expect(scrubbed).toContain("ETIMEDOUT");
  });

  it("removes a bare path fragment carrying the token", () => {
    // Some errors quote only the path — no scheme, so the URL pattern misses it.
    const message = `GET /agenda/${TOKEN}.ics -> 403`;
    expect(redactSecrets(message, [FEED_URL])).not.toContain(TOKEN);
  });

  it("keeps the part of the message a human needs", () => {
    const scrubbed = redactSecrets(`Feed returned 403 Forbidden for ${FEED_URL}`, [FEED_URL]);
    expect(scrubbed).toContain("403 Forbidden");
    expect(scrubbed).toContain("[redacted]");
  });

  it("ignores a secret too short to be one", () => {
    // Redacting "abc" would shred every message that happened to contain it.
    expect(redactSecrets("abc happened", ["abc"])).toBe("abc happened");
  });
});
