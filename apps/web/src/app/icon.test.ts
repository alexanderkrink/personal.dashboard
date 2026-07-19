import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the icon assets, because nothing else does.
 *
 * Biome does not lint SVG, and Next.js serves `app/icon.svg` as a static file without
 * parsing it — so a malformed icon returns a cheerful 200, sails through
 * `typecheck && lint && test && build`, and shows a globe in the tab. That is not a
 * hypothetical: the first version of this icon put the CSS token names (with their leading
 * double dashes) inside an XML comment, which is illegal, and every raster derived from it
 * silently became a broken-image placeholder.
 */

/**
 * Resolved from `process.cwd()`, not `import.meta.url`: the jsdom environment serves this
 * module from an `http://localhost` URL, so `fileURLToPath` rejects it. Same constraint the
 * Playwright config documents. Whether the run starts in apps/web or at the repo root
 * decides which candidate hits.
 */
function iconPath(): string {
  for (const candidate of ["src/app/icon.svg", "apps/web/src/app/icon.svg"]) {
    const full = resolve(process.cwd(), candidate);
    try {
      readFileSync(full);
      return full;
    } catch {
      // try the next one
    }
  }
  throw new Error(`icon.svg not found from ${process.cwd()}`);
}

const ICON = iconPath();

/** The measured sRGB the browser paints for the dark-theme tokens. See icon.svg. */
const AZURE = "#00a4ed"; // accent,     oklch(0.68 0.16 237)
const CANVAS = "#04080b"; // background, oklch(0.13 0.012 237)

describe("icon.svg", () => {
  const source = readFileSync(ICON, "utf8");

  it("is well-formed XML", () => {
    const doc = new DOMParser().parseFromString(source, "image/svg+xml");
    const error = doc.querySelector("parsererror");
    expect(error?.textContent ?? null).toBeNull();
    expect(doc.documentElement.tagName).toBe("svg");
  });

  it("has no double hyphen inside a comment", () => {
    // The specific illegality above, asserted directly: the XML spec forbids `--` in a
    // comment, and it is the one mistake this file invites, since every colour in it has
    // a CSS custom property that is spelled with exactly that.
    for (const [, body] of source.matchAll(/<!--([\s\S]*?)-->/g)) {
      expect(body).not.toContain("--");
    }
  });

  it("paints the azure plate with the canvas knocked out, not the reverse", () => {
    // The polarity is the whole design decision (PLAN.md, "Wordmark, motif & favicon").
    // A canvas-coloured plate measures 1.25:1 against a dark tab strip and disappears.
    const doc = new DOMParser().parseFromString(source, "image/svg+xml");
    expect(doc.querySelector("rect")?.getAttribute("fill")).toBe(AZURE);
    expect(doc.querySelector("circle")?.getAttribute("fill")).toBe(CANVAS);
  });

  it("keeps the dot large enough to survive a 16px favicon", () => {
    const doc = new DOMParser().parseFromString(source, "image/svg+xml");
    const circle = doc.querySelector("circle");
    const radius = Number(circle?.getAttribute("r"));
    const diameterRatio = (radius * 2) / 512;

    // 43.75% of the canvas is 7px at 16px. Below roughly 40% the dot stops reading as a
    // deliberate circle and starts reading as a smudge; above roughly 50% the plate stops
    // reading as a plate and starts reading as a ring.
    expect(diameterRatio).toBeGreaterThanOrEqual(0.4);
    expect(diameterRatio).toBeLessThanOrEqual(0.5);
    expect(circle?.getAttribute("cx")).toBe("256");
    expect(circle?.getAttribute("cy")).toBe("256");
  });

  it("bakes the 20% corner radius into this file only", () => {
    // apple-icon.png and the maskable icon are deliberately full-bleed: iOS and Android
    // apply their own mask, and a baked-in radius double-rounds.
    const doc = new DOMParser().parseFromString(source, "image/svg+xml");
    const rect = doc.querySelector("rect");
    expect(Number(rect?.getAttribute("rx")) / 512).toBeCloseTo(0.2, 5);
  });
});
