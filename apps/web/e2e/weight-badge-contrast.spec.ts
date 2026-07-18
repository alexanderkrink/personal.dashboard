import { expect, test } from "@playwright/test";

/**
 * REGRESSION: the §7 weight badge's text must clear WCAG AA on the tint it sits
 * on, in both themes.
 *
 * 🔴 Caught by measurement, not by review. The badge renders 11px text in an
 * urgency colour on a low-alpha tint of that *same* colour — a field that is by
 * construction the closest surface to the text it carries. At the original 12%
 * tint, `--urgency-medium` measured **4.19:1** in light mode (an AA failure for
 * small text) and the other three tiers cleared 4.5 only narrowly, at 4.57–4.75.
 * Typecheck, lint, unit tests and the build were all green throughout.
 *
 * The fix was two-part: `--urgency-medium` darkened to `oklch(0.52 0.09 78)` and
 * the light-mode tint eased from 12% to 10%. This spec is what stops either half
 * being reverted independently.
 *
 * The measurement rasterises through a canvas so the ENGINE's own OKLCH → sRGB
 * gamut mapping applies. Nine tokens in this system sit outside sRGB, and a
 * checker that parses the OKLCH triple and clips reports optimistically — which
 * is the failure mode that would make this spec pass while the badge is
 * illegible on screen.
 */

/** Small text (< 18.66px bold / 24px regular) — 11px badge numerals. */
const AA_SMALL_TEXT = 4.5;

/** Non-text UI component — the 2px ranking rule down a row's left edge. */
const AA_NON_TEXT = 3;

/** Tint alpha behind badge text, per theme. Must track `TIER_BADGE_CLASS`. */
const TINT_ALPHA = { light: 0.1, dark: 0.2 } as const;

const RAMP = [
  "--urgency-overdue",
  "--urgency-high",
  "--urgency-medium",
  "--urgency-done",
  "--muted-foreground",
] as const;

test.describe("weight-badge contrast", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const theme of ["light", "dark"] as const) {
    test(`${theme}: every heat-ramp tier is legible on its own tint`, async ({ page }) => {
      await page.goto("/");

      const measured = await page.evaluate(
        ({ tokens, mode, alpha }) => {
          document.documentElement.classList.toggle("dark", mode === "dark");

          const canvas = document.createElement("canvas");
          canvas.width = 1;
          canvas.height = 1;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) throw new Error("no 2d context");
          const probe = document.createElement("div");
          document.body.appendChild(probe);

          const srgb = (css: string): [number, number, number] => {
            probe.style.backgroundColor = css;
            const resolved = getComputedStyle(probe).backgroundColor;
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, 1, 1);
            ctx.fillStyle = resolved;
            ctx.fillRect(0, 0, 1, 1);
            const d = ctx.getImageData(0, 0, 1, 1).data;
            return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0];
          };

          // Compositing the tint by hand, exactly as the compositor does, is the
          // whole point: `bg-<token>/10` is never an opaque colour we could read
          // back, so the background the text actually sits on has to be derived.
          const over = (
            fg: [number, number, number],
            a: number,
            bg: [number, number, number],
          ): [number, number, number] => [
            (fg[0] ?? 0) * a + (bg[0] ?? 0) * (1 - a),
            (fg[1] ?? 0) * a + (bg[1] ?? 0) * (1 - a),
            (fg[2] ?? 0) * a + (bg[2] ?? 0) * (1 - a),
          ];

          const channel = (v: number) => {
            const s = v / 255;
            return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          };
          const luminance = ([r, g, b]: [number, number, number]) =>
            0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
          const ratio = (a: [number, number, number], b: [number, number, number]) => {
            const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
            return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
          };

          const surface = srgb("var(--surface)");
          const out: Record<string, number> = {};

          for (const token of tokens) {
            const fg = srgb(`var(${token})`);
            out[`${token} on tint`] = ratio(fg, over(fg, alpha, surface));
            out[`${token} on surface`] = ratio(fg, surface);
          }
          return out;
        },
        { tokens: RAMP as unknown as string[], mode: theme, alpha: TINT_ALPHA[theme] },
      );

      for (const [surface, value] of Object.entries(measured)) {
        expect(value, `${theme}: ${surface}`).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
      }
    });

    test(`${theme}: the row rule clears the non-text floor`, async ({ page }) => {
      await page.goto("/");

      const measured = await page.evaluate(
        ({ mode }) => {
          document.documentElement.classList.toggle("dark", mode === "dark");
          const canvas = document.createElement("canvas");
          canvas.width = 1;
          canvas.height = 1;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) throw new Error("no 2d context");
          const probe = document.createElement("div");
          document.body.appendChild(probe);

          const srgb = (css: string): [number, number, number] => {
            probe.style.backgroundColor = css;
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
          const ratio = (a: [number, number, number], b: [number, number, number]) => {
            const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
            return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
          };

          const surface = srgb("var(--surface)");
          const out: Record<string, number> = {};
          for (const token of ["--urgency-overdue", "--urgency-high", "--urgency-medium"]) {
            out[token] = ratio(srgb(`var(${token})`), surface);
          }
          return out;
        },
        { mode: theme },
      );

      for (const [token, value] of Object.entries(measured)) {
        expect(value, `${theme}: ${token} rule`).toBeGreaterThanOrEqual(AA_NON_TEXT);
      }
    });
  }

  /**
   * 🎨 The invertible one. Green is `done` and nothing else: a green "High"
   * badge reads as *finished* at a glance, which is the single most damaging
   * thing this ramp could say.
   */
  test("no urgency tier is rendered in the done/green hue", async ({ page }) => {
    await page.goto("/");

    const hues = await page.evaluate(() => {
      const probe = document.createElement("div");
      document.body.appendChild(probe);
      const read = (token: string) => {
        probe.style.color = `var(${token})`;
        return getComputedStyle(probe).color;
      };
      return {
        done: read("--urgency-done"),
        overdue: read("--urgency-overdue"),
        high: read("--urgency-high"),
        medium: read("--urgency-medium"),
      };
    });

    expect(hues.overdue).not.toBe(hues.done);
    expect(hues.high).not.toBe(hues.done);
    expect(hues.medium).not.toBe(hues.done);
  });
});
