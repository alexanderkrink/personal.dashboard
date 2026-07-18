import { expect, test } from "@playwright/test";

import { buttonVariants } from "@/components/ui/button";

/**
 * REGRESSION: the outline button's edge must clear WCAG 2.2 SC 1.4.11 (3:1)
 * against both surfaces it borders — the page behind it and its own fill.
 *
 * Wave 1 split `--input-border` out of `--border` and moved *inputs* onto it,
 * because a form control's edge is the only visual boundary of a non-text UI
 * component and so owes 3:1, while the decorative hairline does not. The outline
 * *button* was left behind — and worse than it looked. It nominally carried
 * `border-border`, which would have measured 1.27:1 (light) / 1.41:1 (dark), but
 * the cva base also carried `border-transparent`, an equal-specificity utility
 * that Tailwind happens to emit later. So the border actually resolved to
 * `rgba(0,0,0,0)`: **invisible, 1.00:1**. Reading tokens would never have caught
 * that; only the resolved style on a real element does.
 *
 * Two things make this test worth its weight:
 *
 * 1. It reads the **real component's** resolved styles — the class string comes
 *    from `buttonVariants` itself, so putting the outline variant back on a
 *    decorative token fails here rather than shipping.
 * 2. It rasterises through a canvas so the engine's own OKLCH gamut mapping
 *    applies. Nine tokens in this palette sit outside sRGB and browsers map them
 *    darker; a checker that parses the OKLCH triple and clips channels reports
 *    optimistically and would pass a failing border.
 *
 * Alpha compositing is load-bearing here. On dark, `--input-border` is an alpha
 * token and the outline button carries its own `bg-input/30` fill, so the edge
 * composites over the fill, not over the page. Measuring it flat is exactly the
 * mistake that let a 2.83:1 edge be annotated as 4.12:1 — each probe is
 * therefore painted onto its actual backdrop.
 *
 * `--input-border` is shared with `Input`, so this also transitively pins the
 * input edge that Wave 1 introduced.
 */

/** SC 1.4.11 — non-text contrast, for UI component boundaries. */
const NON_TEXT_MIN = 3;

test.describe("control border contrast", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const theme of ["light", "dark"] as const) {
    test(`${theme}: the outline button edge clears 3:1 on both adjacent surfaces`, async ({
      page,
    }) => {
      // next-themes owns the `dark` class and re-applies it on hydration, so
      // toggling it by hand races the provider. Seed its storage key instead and
      // wait for the class to actually settle.
      await page.addInitScript((t) => window.localStorage.setItem("theme", t), theme);
      await page.goto("/");
      await page.waitForFunction(
        (t) => document.documentElement.classList.contains("dark") === (t === "dark"),
        theme,
      );

      const ratios = await page.evaluate(
        ({ buttonClass }) => {
          const host = document.createElement("div");
          host.style.backgroundColor = "var(--background)";
          const button = document.createElement("button");
          button.className = buttonClass;
          button.textContent = "probe";
          host.appendChild(button);
          document.body.appendChild(host);

          const buttonStyle = getComputedStyle(button);
          const edgeColor = buttonStyle.borderLeftColor;
          const fillColor = buttonStyle.backgroundColor;
          const pageColor = getComputedStyle(host).backgroundColor;

          const canvas = document.createElement("canvas");
          canvas.width = 1;
          canvas.height = 1;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) throw new Error("no 2d context");

          // Painting is what forces the engine's OKLCH -> sRGB gamut mapping;
          // reading the computed string back would hand us the untouched triple.
          // Layers are painted in order onto opaque white, so an alpha edge
          // composites against its real backdrop instead of being read flat.
          //
          // An arrow const, not a `function` declaration: a hoisted declaration
          // could in principle run before the null check above, so TS refuses to
          // carry the narrowing of `ctx` into it.
          const paint = (layers: readonly string[]): [number, number, number] => {
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, 1, 1);
            for (const layer of layers) {
              ctx.fillStyle = layer;
              ctx.fillRect(0, 0, 1, 1);
            }
            const d = ctx.getImageData(0, 0, 1, 1).data;
            return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0];
          };

          const channel = (v: number) => {
            const s = v / 255;
            return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          };
          const luminance = ([r, g, b]: [number, number, number]) =>
            0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
          const contrast = (a: [number, number, number], b: [number, number, number]) => {
            const la = luminance(a);
            const lb = luminance(b);
            return Math.round(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)) * 100) / 100;
          };

          const onPage = paint([pageColor]);
          const onFill = paint([pageColor, fillColor]);
          const edgeOverFill = paint([pageColor, fillColor, edgeColor]);
          const edgeOverPage = paint([pageColor, edgeColor]);

          host.remove();
          return {
            "edge vs the button's own fill": contrast(edgeOverFill, onFill),
            "edge vs the page behind it": contrast(edgeOverPage, onPage),
          };
        },
        { buttonClass: buttonVariants({ variant: "outline" }) },
      );

      // Logged so the measured numbers are recoverable from a CI run, not just
      // a pass/fail.
      console.log(`[${theme}] outline button edge:`, JSON.stringify(ratios));

      for (const [pair, ratio] of Object.entries(ratios)) {
        expect(ratio, `${pair} (${theme})`).toBeGreaterThanOrEqual(NON_TEXT_MIN);
      }
    });
  }
});
