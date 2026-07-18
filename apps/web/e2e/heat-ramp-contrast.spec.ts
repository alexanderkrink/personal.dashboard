import { expect, test } from "@playwright/test";

/**
 * REGRESSION: heat-ramp text must clear WCAG AA on every surface it lands on —
 * including the hovered table row.
 *
 * `--urgency-high` was tuned against the canvas only. PLAN's table rule sets the
 * hover highlight to `--accent-subtle` (an azure tint over `--surface`), which
 * is the *least* contrasting background in the system, so amber weight totals in
 * a hovered row measured 4.41:1 — a SC 1.4.3 failure at exactly the moment the
 * user points at the number. Typecheck, lint and unit tests are all blind to it.
 *
 * The measurement rasterises each token to sRGB through the browser so the
 * engine's own OKLCH gamut mapping applies. Several of these tokens are outside
 * sRGB; a checker that parses the OKLCH triple and clips reports optimistically.
 */

/** Surfaces heat-ramp text is rendered on, worst-contrast one first. */
const SURFACES = ["--accent-subtle", "--surface", "--background"] as const;

/** Small text (< 18.66px bold / 24px regular) — the numerals in a table cell. */
const AA_SMALL_TEXT = 4.5;

test.describe("heat-ramp contrast", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const theme of ["light", "dark"] as const) {
    test(`${theme}: warning and success clear AA on every surface they sit on`, async ({
      page,
    }) => {
      await page.goto("/");

      const ratios = await page.evaluate(
        ({ surfaces, mode }) => {
          document.documentElement.classList.toggle("dark", mode === "dark");

          const canvas = document.createElement("canvas");
          canvas.width = 1;
          canvas.height = 1;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) throw new Error("no 2d context");
          const probe = document.createElement("div");
          document.body.appendChild(probe);

          // Painting through the canvas is what forces the engine's OKLCH ->
          // sRGB gamut mapping; reading the computed value back as a string
          // would hand us the untouched OKLCH triple.
          //
          // An arrow const, not a `function` declaration: a hoisted declaration
          // could in principle run before the null check above, so TS refuses to
          // carry the narrowing of `ctx` into it.
          const srgb = (token: string): [number, number, number] => {
            probe.style.backgroundColor = `var(${token})`;
            const resolved = getComputedStyle(probe).backgroundColor;
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, 1, 1);
            ctx.fillStyle = resolved;
            ctx.fillRect(0, 0, 1, 1);
            const d = ctx.getImageData(0, 0, 1, 1).data;
            return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0];
          };

          const channel = (v: number) => {
            const s = v / 255;
            return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          };
          const luminance = ([r, g, b]: [number, number, number]) =>
            0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

          const out: Record<string, number> = {};
          for (const fg of ["--warning", "--success"]) {
            for (const bg of surfaces) {
              const a = luminance(srgb(fg));
              const b = luminance(srgb(bg));
              const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
              out[`${fg} on ${bg}`] = Math.round(ratio * 100) / 100;
            }
          }
          probe.remove();
          return out;
        },
        { surfaces: SURFACES, mode: theme },
      );

      for (const [pair, ratio] of Object.entries(ratios)) {
        expect(ratio, `${pair} (${theme})`).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
      }
    });
  }
});
