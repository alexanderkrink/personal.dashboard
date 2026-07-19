import { expect, test } from "@playwright/test";

/**
 * REGRESSION: the exam panel's `feed_derived` provenance chip must be legible.
 *
 * 🚨 This is the honesty signal. "From the feed" is the label that discloses the
 * exam-oracle circularity — `detectExam` reports `syllabus_total_sessions` for
 * all 7 fall courses while `courses.total_sessions_source` says the counts were
 * read off this same feed. It is the one chip in the system that must never be
 * hard to read, because it is the only thing on screen arguing against the
 * confident number beside it.
 *
 * It was rendered in `--urgency-medium`, the PAINTING token, at 11px on a 10%
 * wash of its own hue. Fixed 2026-07-19 to `--urgency-medium-text`.
 *
 * ## Two numbers, because they answer different questions
 *
 * - **composite** — the specified text colour against the composited
 *   background. This is what WCAG SC 1.4.3 is literally defined on. Was 4.80:1.
 * - **sampled** — the actual anti-aliased glyph pixels off a real screenshot at
 *   1x. Was **4.55:1**, under the floor. This is the number a reader's eye
 *   actually gets, and on this chip it is the one that matters.
 *
 * Both are asserted, so neither half of the fix can be reverted alone.
 *
 * ## ⚠ Two sampling traps this spec is built to avoid
 *
 * 1. **`getComputedStyle` can return `lab()`/`oklch()`.** A naive parser reads
 *    those as opaque and reports 1.00:1 for everything. So every colour here is
 *    rasterised by painting it into a canvas — which also forces the engine's
 *    own out-of-sRGB gamut mapping, the thing that makes nine of this system's
 *    tokens render darker than their OKLCH triple suggests.
 * 2. **11px anti-aliased glyphs never reach a 1% single-colour share.** A
 *    sampler that looks for a dominant ink colour finds only the background and
 *    reports 1:1. So pixels are ranked by distance from the background and the
 *    colour at the 20th percentile of cumulative distance mass is taken as the
 *    glyph body.
 */

/** Small text (< 18.66px bold / 24px regular) — an 11px 500-weight chip label. */
const AA_SMALL_TEXT = 4.5;

/** Exactly what `CONFIDENCE_CHIP.feed_derived` renders. Must track exam-panel.tsx. */
const CHIP_CLASS =
  "inline-flex h-5 shrink-0 items-center rounded-4xl px-2 font-medium text-ui-xs " +
  "bg-urgency-medium/10 text-urgency-medium-text dark:bg-urgency-medium/20";

/** The chip sits in a `bg-surface` section, on rows that add no background. */
const SURFACE_CLASS = "bg-surface";

test.describe("exam provenance chip contrast", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const theme of ["light", "dark"] as const) {
    for (const width of [1280, 375]) {
      test(`${theme} @${width}px: "From the feed" clears AA as specified and as rendered`, async ({
        browser,
      }) => {
        // 1x on purpose. A 2x/3x raster resolves the glyph body to the full
        // specified colour and hides the anti-aliasing loss entirely — the
        // measurement would pass while the 1x display it was reported on fails.
        const page = await browser.newPage({
          viewport: { width, height: 900 },
          deviceScaleFactor: 1,
        });
        await page.goto("/");

        const { composite, box } = await page.evaluate(
          ({ chipClass, surfaceClass, mode }) => {
            document.documentElement.classList.toggle("dark", mode === "dark");

            const host = document.createElement("div");
            host.className = surfaceClass;
            host.setAttribute(
              "style",
              "position:fixed;inset:0;z-index:99999;display:flex;align-items:flex-start;padding:40px;",
            );
            const chip = document.createElement("span");
            chip.className = chipClass;
            chip.textContent = "From the feed";
            host.appendChild(chip);
            document.body.appendChild(host);

            const canvas = document.createElement("canvas");
            canvas.width = 1;
            canvas.height = 1;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (!ctx) throw new Error("no 2d context");
            const probe = document.createElement("div");
            document.body.appendChild(probe);

            const paint = (css: string): [number, number, number] => {
              probe.style.backgroundColor = css;
              const resolved = getComputedStyle(probe).backgroundColor;
              ctx.fillStyle = "#ffffff";
              ctx.fillRect(0, 0, 1, 1);
              ctx.fillStyle = resolved;
              ctx.fillRect(0, 0, 1, 1);
              const d = ctx.getImageData(0, 0, 1, 1).data;
              return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0];
            };

            const style = getComputedStyle(chip);
            const fg = paint(style.color);

            // The chip's fill is translucent, so let the ENGINE composite it
            // over the surface rather than parsing an alpha out of a string
            // that may not even be in rgb() syntax.
            probe.style.backgroundColor = "var(--surface)";
            const surfaceResolved = getComputedStyle(probe).backgroundColor;
            probe.style.backgroundColor = style.backgroundColor;
            const chipResolved = getComputedStyle(probe).backgroundColor;
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, 1, 1);
            ctx.fillStyle = surfaceResolved;
            ctx.fillRect(0, 0, 1, 1);
            ctx.fillStyle = chipResolved;
            ctx.fillRect(0, 0, 1, 1);
            const bd = ctx.getImageData(0, 0, 1, 1).data;
            const bg: [number, number, number] = [bd[0] ?? 0, bd[1] ?? 0, bd[2] ?? 0];

            const chan = (v: number) => {
              const s = v / 255;
              return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            };
            const lum = ([r, g, b]: [number, number, number]) =>
              0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
            const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);

            const rect = chip.getBoundingClientRect();
            return {
              composite: ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05),
              box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            };
          },
          { chipClass: CHIP_CLASS, surfaceClass: SURFACE_CLASS, mode: theme },
        );

        const shot = await page.screenshot({ clip: box });

        const sampled = await page.evaluate(
          async (dataUrl: string) => {
            const img = new Image();
            img.src = dataUrl;
            await img.decode();
            const c = document.createElement("canvas");
            c.width = img.width;
            c.height = img.height;
            const cx = c.getContext("2d", { willReadFrequently: true });
            if (!cx) throw new Error("no 2d context");
            cx.drawImage(img, 0, 0);
            const d = cx.getImageData(0, 0, c.width, c.height).data;

            const pixels: [number, number, number][] = [];
            for (let i = 0; i < d.length; i += 4) {
              pixels.push([d[i] ?? 0, d[i + 1] ?? 0, d[i + 2] ?? 0]);
            }

            // The chip fill dominates by area, so the modal colour is the field
            // the glyphs sit on.
            const tally = new Map<string, number>();
            for (const p of pixels) {
              const key = `${p[0]},${p[1]},${p[2]}`;
              tally.set(key, (tally.get(key) ?? 0) + 1);
            }
            const modal = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "0,0,0";
            const parts = modal.split(",").map(Number);
            const bg: [number, number, number] = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];

            const distance = (p: [number, number, number]) =>
              Math.hypot(p[0] - bg[0], p[1] - bg[1], p[2] - bg[2]);

            // Cumulative-distance thresholding — see the header. Share-based
            // thresholds report the background and score 1:1 on 11px text.
            const ranked = pixels.map((p) => ({ p, d: distance(p) })).sort((a, b) => b.d - a.d);
            const total = ranked.reduce((sum, r) => sum + r.d, 0);
            let acc = 0;
            let glyph: [number, number, number] = ranked[0]?.p ?? bg;
            for (const r of ranked) {
              acc += r.d;
              glyph = r.p;
              if (acc >= total * 0.2) break;
            }

            const chan = (v: number) => {
              const s = v / 255;
              return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            };
            const lum = ([r, g, b]: [number, number, number]) =>
              0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
            const [hi, lo] = [lum(glyph), lum(bg)].sort((x, y) => y - x);
            return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
          },
          `data:image/png;base64,${shot.toString("base64")}`,
        );

        expect(composite, `${theme} @${width}: specified colours`).toBeGreaterThanOrEqual(
          AA_SMALL_TEXT,
        );
        expect(sampled, `${theme} @${width}: rendered glyph pixels`).toBeGreaterThanOrEqual(
          AA_SMALL_TEXT,
        );

        await page.close();
      });
    }
  }

  /**
   * 🎨 The chip must stay amber. Green is `done` and nothing else — a green
   * "From the feed" would read as *verified*, which is the precise opposite of
   * what this label exists to say.
   */
  test("the provenance chip is never rendered in the done/green hue", async ({ page }) => {
    await page.goto("/");

    const same = await page.evaluate(() => {
      const probe = document.createElement("div");
      document.body.appendChild(probe);
      const read = (token: string) => {
        probe.style.color = `var(${token})`;
        return getComputedStyle(probe).color;
      };
      return {
        light: read("--urgency-medium-text") === read("--urgency-done"),
        dark: (() => {
          document.documentElement.classList.add("dark");
          const clash = read("--urgency-medium-text") === read("--urgency-done");
          document.documentElement.classList.remove("dark");
          return clash;
        })(),
      };
    });

    expect(same.light, "light: chip hue must not equal --urgency-done").toBe(false);
    expect(same.dark, "dark: chip hue must not equal --urgency-done").toBe(false);
  });
});
