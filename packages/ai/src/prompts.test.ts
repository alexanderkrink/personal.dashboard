import { describe, expect, it } from "vitest";
import { echoPrompt } from "./prompts";
import { documentSummarySchema } from "./schemas";

describe("prompt registry", () => {
  it("renders template variables", () => {
    expect(echoPrompt.render({ subject: "photosynthesis" })).toContain("photosynthesis");
  });

  it("carries id and version for traceability", () => {
    expect(echoPrompt.id).toBe("echo-example");
    expect(echoPrompt.version).toBe(1);
  });
});

describe("structured-output schemas", () => {
  it("accepts a valid document summary", () => {
    const parsed = documentSummarySchema.safeParse({
      title: "Lecture 1",
      summary: "An introduction.",
      keyTerms: [{ term: "GDP", definition: "Gross domestic product" }],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a summary with missing fields", () => {
    expect(documentSummarySchema.safeParse({ title: "" }).success).toBe(false);
  });
});
