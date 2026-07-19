import { expect, test } from "@playwright/test";

/**
 * REGRESSION: every rung of the heat ramp must clear WCAG AA **as rendered**,
 * not merely as specified.
 *
 * `weight-badge-contrast.spec.ts` already pins the *composite* number — the
 * specified text colour over the composited tint, which is what SC 1.4.3 is
 * literally defined on. That spec was green while two tiers were illegible,
 * because 11px 500-weight glyphs on a 10% wash of their own hue never resolve
 * to the specified colour. This spec pins the number a reader's eye actually
 * gets, for the whole ramp, so no tier can silently drop below the floor again.
 *
 * Measured 2026-07-19, light theme, uniform probe label, p20, 1x:
 *
 *   tier           composite  sampled
 *   overdue        4.89       4.74     ok
 *   high           4.68       4.42  <- FAILED, the loudest rung of the ramp
 *   medium         4.80       4.55     thin
 *   done           4.76       4.50  <- exactly on the floor, zero headroom
 *
 * Fixed by giving `high` and `done` the `-text` sibling that `--accent` /
 * `--accent-text` and `--urgency-medium` / `--urgency-medium-text` already
 * established: the painting token keeps the 2px rule and the `--warning` /
 * `--success` aliases, and a darker writing token carries the glyphs. `medium`
 * moved onto its existing `-text` token at the same time, so every badge in the
 * ramp now writes with a `-text` token and none of them sits under 5.3.
 *
 * ## ⚠ Three traps this spec is built to avoid
 *
 * 1. **`getComputedStyle` can return `lab()`/`oklch()`.** A naive parser reads
 *    those as opaque and scores 1.00:1 for everything. Every colour here is
 *    rasterised through a canvas, which also forces the engine's own
 *    out-of-sRGB gamut mapping — nine tokens in this system render darker than
 *    their OKLCH triple implies.
 * 2. **11px anti-aliased glyphs never reach a 1% single-colour share.** A
 *    sampler hunting a dominant ink colour finds only the background and scores
 *    1:1. Pixels are ranked by distance from the background and the colour at
 *    the 20th percentile of cumulative distance mass is taken as the glyph body.
 * 3. **Tailwind v4 JIT only emits classes it finds in source.** A probe using
 *    an invented tint silently resolves to `rgba(0,0,0,0)` and measures against
 *    bare surface — reporting far too high. Likewise an undefined text token
 *    inherits the body foreground and reports ~15:1. Both are asserted against
 *    below, so a typo in a class string fails loudly instead of passing.
 *
 * 🚨 The `high`/`done` failure is **DPR-dependent**: at 2x/3x the glyph core
 * resolves to the full composite value and both numbers pass. That is exactly
 * why token-math checkers and retina spot-checks missed it. `deviceScaleFactor`
 * is pinned to 1 on purpose — do not "fix" a future failure by raising it.
 */

/** Small text (< 18.66px bold / 24px regular) — 11px badge labels. */
const AA_SMALL_TEXT = 4.5;

/**
 * One probe string for every tier, deliberately.
 *
 * The sampled ratio degrades as glyph mass grows, so the number is a property
 * of (token, label, threshold) rather than of the token alone — `--urgency-high`
 * measures 4.65 as "High" but 4.42 as "From the feed". A token must be legible
 * for any label it may carry, so the longest label in the system is used as the
 * worst case for all of them. Changing this string changes every number here.
 */
const PROBE_LABEL = "From the feed";

/** The badge/chip shell: 11px, 500 weight. Must track `deadline-row.tsx`. */
const CHIP_BASE = "inline-flex h-5 shrink-0 items-center rounded-4xl px-2 font-medium text-ui-xs";

/**
 * Every tier as production renders it. These strings MUST stay byte-identical
 * to `TIER_BADGE_CLASS` in `urgency.ts`, `deadline-row.tsx`'s completed badge
 * and exam tag, and `CONFIDENCE_CHIP` in `exam-panel.tsx` — a drift here means
 * the spec is pinning something the app no longer renders.
 */
const TIERS: { name: string; cls: string }[] = [
  // urgency.ts — TIER_BADGE_CLASS
  { name: "overdue", cls: "bg-urgency-overdue/10 text-urgency-overdue dark:bg-urgency-overdue/20" },
  { name: "high", cls: "bg-urgency-high/10 text-urgency-high-text dark:bg-urgency-high/20" },
  {
    name: "medium",
    cls: "bg-urgency-medium/10 text-urgency-medium-text dark:bg-urgency-medium/20",
  },
  { name: "low", cls: "bg-muted text-muted-foreground" },
  // deadline-row.tsx — completed badge, and the "Exam" tag on a row title
  { name: "done", cls: "bg-urgency-done/10 text-urgency-done-text" },
  { name: "exam-tag", cls: "bg-urgency-high/10 text-urgency-high-text dark:bg-urgency-high/20" },
  // exam-panel.tsx — CONFIDENCE_CHIP
  {
    name: "chip-feed",
    cls: "bg-urgency-medium/10 text-urgency-medium-text dark:bg-urgency-medium/20",
  },
  { name: "chip-syllabus", cls: "bg-accent-subtle text-accent-text" },
];

test.describe("urgency ramp contrast", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const theme of ["light", "dark"] as const) {
    for (const width of [1280, 375]) {
      test(`${theme} @${width}px: every tier clears AA as specified and as rendered`, async ({
        browser,
      }) => {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
          deviceScaleFactor: 1, // see the DPR note in the header
        });
        await page.goto("/");

        const measured = await page.evaluate(
          ({ tiers, base, mode, label }) => {
            document.documentElement.classList.toggle("dark", mode === "dark");

            const host = document.createElement("div");
            host.className = "bg-surface";
            host.setAttribute(
              "style",
              "position:fixed;inset:0;z-index:99999;padding:32px;display:flex;" +
                "flex-direction:column;gap:18px;align-items:flex-start;",
            );
            document.body.appendChild(host);

            const canvas = document.createElement("canvas");
            canvas.width = 1;
            canvas.height = 1;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (!ctx) throw new Error("no 2d context");
            const probe = document.createElement("div");
            document.body.appendChild(probe);

            // Painting through the canvas is what applies the engine's OKLCH ->
            // sRGB gamut mapping; reading the string back would not.
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
            const chan = (v: number) => {
              const s = v / 255;
              return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            };
            const lum = ([r, g, b]: [number, number, number]) =>
              0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);

            const bodyColor = getComputedStyle(document.body).color;
            const out: Record<
              string,
              {
                composite: number;
                tintMissing: boolean;
                colorInherited: boolean;
                box: { x: number; y: number; width: number; height: number };
              }
            > = {};

            for (const tier of tiers) {
              const chip = document.createElement("span");
              chip.className = `${base} ${tier.cls}`;
              chip.textContent = label;
              host.appendChild(chip);

              const cs = getComputedStyle(chip);
              const fg = srgb(cs.color);

              // Let the ENGINE composite the translucent tint over the surface
              // rather than parsing an alpha out of a string that may not even
              // be in rgb() syntax.
              probe.style.backgroundColor = "var(--surface)";
              const surfaceResolved = getComputedStyle(probe).backgroundColor;
              probe.style.backgroundColor = cs.backgroundColor;
              const chipResolved = getComputedStyle(probe).backgroundColor;
              ctx.fillStyle = "#ffffff";
              ctx.fillRect(0, 0, 1, 1);
              ctx.fillStyle = surfaceResolved;
              ctx.fillRect(0, 0, 1, 1);
              ctx.fillStyle = chipResolved;
              ctx.fillRect(0, 0, 1, 1);
              const bd = ctx.getImageData(0, 0, 1, 1).data;
              const bg: [number, number, number] = [bd[0] ?? 0, bd[1] ?? 0, bd[2] ?? 0];

              const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
              const r = chip.getBoundingClientRect();
              out[tier.name] = {
                composite: ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05),
                // trap 3: a tint JIT never emitted, or a token that does not exist
                tintMissing: /rgba\(0,\s*0,\s*0,\s*0\)/.test(cs.backgroundColor),
                colorInherited: cs.color === bodyColor,
                box: { x: r.x, y: r.y, width: r.width, height: r.height },
              };
            }
            return out;
          },
          { tiers: TIERS, base: CHIP_BASE, mode: theme, label: PROBE_LABEL },
        );

        for (const tier of TIERS) {
          const m = measured[tier.name];
          if (!m) throw new Error(`no measurement for ${tier.name}`);

          // Trap 3, asserted before the ratios: either of these makes the
          // numbers below meaningless-but-passing.
          expect(
            m.tintMissing,
            `${tier.name}: background resolved transparent — the tint class is not in ` +
              `source, so Tailwind never emitted it and this measured bare surface`,
          ).toBe(false);
          expect(
            m.colorInherited,
            `${tier.name}: text colour equals the body foreground — the token does not ` +
              `exist, so this measured inherited text`,
          ).toBe(false);

          const shot = await page.screenshot({ clip: m.box });

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

              // The tint dominates by area, so the modal colour is the field.
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

              // Trap 2: cumulative-distance thresholding.
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

          expect(
            m.composite,
            `${tier.name} ${theme} @${width}: specified colours`,
          ).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
          expect(
            sampled,
            `${tier.name} ${theme} @${width}: rendered glyph pixels`,
          ).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
        }

        await page.close();
      });
    }
  }

  /**
   * 🎨 The invertible one, restated against the writing tokens.
   *
   * Green is `done` and nothing else. A green "High" badge reads as *finished*
   * at a glance — the single most damaging thing this ramp could say. The fix
   * above moved lightness only; this asserts hue never followed.
   */
  test("no urgency tier is rendered in the done/green hue", async ({ page }) => {
    await page.goto("/");

    const read = async (mode: "light" | "dark") =>
      page.evaluate((m) => {
        document.documentElement.classList.toggle("dark", m === "dark");
        const probe = document.createElement("div");
        document.body.appendChild(probe);
        const rgb = (token: string) => {
          probe.style.color = `var(${token})`;
          return getComputedStyle(probe).color;
        };
        const out = {
          done: rgb("--urgency-done"),
          doneText: rgb("--urgency-done-text"),
          overdue: rgb("--urgency-overdue"),
          high: rgb("--urgency-high"),
          highText: rgb("--urgency-high-text"),
          medium: rgb("--urgency-medium"),
          mediumText: rgb("--urgency-medium-text"),
        };
        probe.remove();
        return out;
      }, mode);

    for (const mode of ["light", "dark"] as const) {
      const c = await read(mode);
      // No urgency tier may collide with either green token.
      for (const [name, value] of [
        ["overdue", c.overdue],
        ["high", c.high],
        ["high-text", c.highText],
        ["medium", c.medium],
        ["medium-text", c.mediumText],
      ] as const) {
        expect(value, `${mode}: ${name} must not equal --urgency-done`).not.toBe(c.done);
        expect(value, `${mode}: ${name} must not equal --urgency-done-text`).not.toBe(c.doneText);
      }
    }
  });

  /**
   * The writing tokens must stay *darker* than the painting tokens they came
   * from in light mode, and identical in dark mode. This is what stops a future
   * edit "simplifying" the split away by aliasing a `-text` token straight back
   * to its paint in the light column, which would silently reintroduce the
   * exact failure this spec exists to catch.
   */
  test("light-mode writing tokens are darker than their painting tokens", async ({ page }) => {
    await page.goto("/");

    const rel = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("no 2d context");
      const probe = document.createElement("div");
      document.body.appendChild(probe);
      const lumOf = (token: string) => {
        probe.style.backgroundColor = `var(${token})`;
        const resolved = getComputedStyle(probe).backgroundColor;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, 1, 1);
        ctx.fillStyle = resolved;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        const chan = (v: number) => {
          const s = v / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * chan(d[0] ?? 0) + 0.7152 * chan(d[1] ?? 0) + 0.0722 * chan(d[2] ?? 0);
      };

      document.documentElement.classList.remove("dark");
      const light = {
        high: lumOf("--urgency-high"),
        highText: lumOf("--urgency-high-text"),
        medium: lumOf("--urgency-medium"),
        mediumText: lumOf("--urgency-medium-text"),
        done: lumOf("--urgency-done"),
        doneText: lumOf("--urgency-done-text"),
      };
      document.documentElement.classList.add("dark");
      const dark = {
        high: lumOf("--urgency-high"),
        highText: lumOf("--urgency-high-text"),
        done: lumOf("--urgency-done"),
        doneText: lumOf("--urgency-done-text"),
      };
      document.documentElement.classList.remove("dark");
      probe.remove();
      return { light, dark };
    });

    expect(rel.light.highText, "light: --urgency-high-text darker than paint").toBeLessThan(
      rel.light.high,
    );
    expect(rel.light.mediumText, "light: --urgency-medium-text darker than paint").toBeLessThan(
      rel.light.medium,
    );
    expect(rel.light.doneText, "light: --urgency-done-text darker than paint").toBeLessThan(
      rel.light.done,
    );

    // Dark mode aliases through on purpose — darkening there would wreck a
    // colour that has to stay light on a dark surface.
    expect(rel.dark.highText, "dark: --urgency-high-text aliases its paint").toBeCloseTo(
      rel.dark.high,
      5,
    );
    expect(rel.dark.doneText, "dark: --urgency-done-text aliases its paint").toBeCloseTo(
      rel.dark.done,
      5,
    );
  });
});
