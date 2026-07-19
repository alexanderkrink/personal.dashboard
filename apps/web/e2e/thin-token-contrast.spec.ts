import { expect, test } from "@playwright/test";

/**
 * MEASUREMENT + REGRESSION for the two thinnest tokens in the system.
 *
 * `--urgency-overdue` and `--accent-text` both clear the 4.5 small-text floor,
 * but with the least headroom of anything in the palette. `a917d7d` and
 * `322af09` fixed every token that was actually *under* the floor; these two
 * were left alone and never had their full render surface measured — only one
 * site each, via `urgency-ramp-contrast.spec.ts` (the `overdue` and
 * `chip-syllabus` rows, both 11px/500 badges).
 *
 * This spec measures EVERY place either token is written as text, at both
 * themes and both widths, and pins the numbers. Method is copied wholesale from
 * `urgency-ramp-contrast.spec.ts` — see that file's header for the three
 * sampling traps (lab()/oklch() parsing, sub-1% glyph share, Tailwind v4 JIT
 * emitting only classes it finds in source). All three are asserted below.
 *
 * 🚨 Two render sites here are THINNER than anything the ramp spec covers:
 *
 *   - `day-today` (week-grid.tsx `DayHeading`) — 11px font-mono at weight 400
 *     on `--accent-subtle`, the least contrasting background in the system.
 *     The ramp spec's `chip-syllabus` is the same token at weight 500.
 *   - `exam-conflict` / `due-in` — `--urgency-overdue` at weight 400, where the
 *     ramp spec only ever measured it at 500 on a tint.
 *
 * Weight 400 loses more of the glyph body to anti-aliasing than weight 500, so
 * a token can pass the ramp spec and still be thinner in production. That is
 * the gap this file closes.
 *
 * `deviceScaleFactor` is pinned to 1 on purpose — at 2x/3x the glyph core
 * resolves to the full composite value and every number here passes. Do not
 * "fix" a future failure by raising it.
 */

/** Small text (< 18.66px bold / 24px regular) — every site here is 11-12px. */
const AA_SMALL_TEXT = 4.5;

/**
 * ⚠️ There is deliberately NO per-site exemption map here.
 *
 * An earlier draft of this file carried one, because the two failing sites wrote
 * with `--urgency-overdue` — the PAINTING token — and the writing token that
 * fixes them (`--urgency-overdue-text`) had been declared but not yet wired at
 * the call sites. Both halves have since landed: `urgency.ts`, `sync-strip.tsx`,
 * `this-week.tsx`, `deadline-row.tsx` and `exam-panel.tsx` all write with
 * `text-urgency-overdue-text`, and every site below clears 4.5 outright.
 *
 * If a site here ever drops under the floor again, the answer is a token change
 * or a call-site change — never a new allowance. A per-site floor below AA is a
 * accessibility failure with a comment on it.
 */

/** The badge/chip shell shared by `urgency.ts` and `exam-panel.tsx`. */
const CHIP_BASE = "inline-flex h-5 shrink-0 items-center rounded-4xl px-2 font-medium text-ui-xs";

type Site = {
  /** Report key. */
  name: string;
  /** Which token this site writes with. */
  token: "--urgency-overdue-text" | "--accent-text";
  /** Class string, byte-identical to the production component named in `from`. */
  cls: string;
  /** The text the component actually renders. Sampled ratio depends on it. */
  label: string;
  /** The surface the site sits on, as a Tailwind class on the host. */
  host: string;
  /** False for sites that paint no tint of their own — see trap 3 below. */
  hasTint: boolean;
  /** Production source of the class string. */
  from: string;
};

/**
 * Every place either token is written as TEXT, exactly as production renders it.
 *
 * These strings MUST stay byte-identical to the components named in `from`.
 * The painting-only uses (`border-urgency-overdue/40`, `bg-urgency-overdue`
 * dot in `TIER_DOT_CLASS`, `--ring`) are deliberately absent: those are
 * graphical objects at the 3:1 floor, not text.
 */
const SITES: Site[] = [
  // ---- --urgency-overdue ----
  {
    name: "overdue-badge",
    token: "--urgency-overdue-text",
    cls: `${CHIP_BASE} bg-urgency-overdue/10 text-urgency-overdue-text dark:bg-urgency-overdue/20`,
    label: "Overdue",
    host: "bg-surface",
    hasTint: true,
    from: "urgency.ts TIER_BADGE_CLASS.overdue",
  },
  {
    name: "sync-fail-chip",
    token: "--urgency-overdue-text",
    cls:
      "inline-flex items-center gap-1.5 rounded-4xl bg-urgency-overdue/10 px-2 py-0.5 " +
      "text-urgency-overdue-text text-ui-xs dark:bg-urgency-overdue/20",
    // The label span inside this chip is font-medium; the status word is not.
    // Weight 400 is the worse half, so that is what is measured.
    label: "Sync failed",
    host: "bg-surface",
    hasTint: true,
    from: "sync-strip.tsx failing-feed chip",
  },
  {
    name: "exam-conflict",
    token: "--urgency-overdue-text",
    cls: "inline-flex items-center gap-1.5 text-urgency-overdue-text text-ui-xs",
    label: "Syllabus says 12 sessions, feed has 14",
    host: "bg-surface",
    hasTint: false,
    from: "exam-panel.tsx conflict line",
  },
  {
    name: "overdue-header",
    token: "--urgency-overdue-text",
    cls:
      "border-urgency-overdue/30 border-b bg-urgency-overdue/8 px-4 py-2 font-medium " +
      "text-urgency-overdue-text text-ui-sm dark:bg-urgency-overdue/12",
    label: "Overdue 3",
    host: "bg-surface",
    hasTint: true,
    from: "this-week.tsx overdue section heading",
  },
  {
    name: "due-in",
    token: "--urgency-overdue-text",
    cls: "font-mono text-ui-sm tabular-nums text-urgency-overdue-text",
    label: "4 days ago",
    host: "bg-surface",
    hasTint: false,
    from: "deadline-row.tsx overdue due-in",
  },

  // ---- --accent-text ----
  {
    name: "chip-syllabus",
    token: "--accent-text",
    cls: `${CHIP_BASE} bg-accent-subtle text-accent-text`,
    label: "From the syllabus",
    host: "bg-surface",
    hasTint: true,
    from: "exam-panel.tsx CONFIDENCE_CHIP.syllabus",
  },
  {
    // 🚨 The thin one. 11px mono at weight 400, and the cell it sits in is
    // `bg-accent-subtle` — so this is accent ink on an accent wash.
    name: "day-today",
    token: "--accent-text",
    cls: "flex items-baseline gap-1.5 font-mono text-ui-xs tabular-nums text-accent-text",
    label: "MON 21",
    host: "bg-accent-subtle",
    hasTint: false,
    from: "week-grid.tsx DayHeading isToday",
  },
  {
    name: "auth-link",
    token: "--accent-text",
    // Light `--background` (L 0.98) is DARKER than `--surface` (L 0.995), so
    // the auth pages are the worse of the two untinted surfaces in light mode.
    cls: "text-accent-text text-ui-sm underline-offset-4",
    label: "Forgot?",
    host: "bg-background",
    hasTint: false,
    from: "sign-in-form.tsx forgot-password link",
  },
  {
    name: "sync-link",
    token: "--accent-text",
    cls: "text-accent-text underline-offset-2 text-ui-sm",
    label: "Connect one",
    host: "bg-surface",
    hasTint: false,
    from: "sync-strip.tsx empty-state link",
  },
];

/**
 * The uniform worst-case probe `urgency-ramp-contrast.spec.ts` uses. Re-run
 * here on the two headline sites purely so these numbers stay comparable with
 * the 4.74 / 4.66 already recorded against those tokens — the sampled ratio is
 * a property of (token, label, threshold), so a different label is a different
 * number and not a regression.
 */
const UNIFORM_SITES: Site[] = [
  { ...(SITES[0] as Site), name: "overdue-badge (uniform probe)", label: "From the feed" },
  { ...(SITES[5] as Site), name: "chip-syllabus (uniform probe)", label: "From the feed" },
];

const ALL = [...SITES, ...UNIFORM_SITES];

type Measurement = {
  composite: number;
  fg: [number, number, number];
  bg: [number, number, number];
  tintMissing: boolean;
  colorInherited: boolean;
  box: { x: number; y: number; width: number; height: number };
};

const rows: string[] = [];

test.describe("thin-token contrast: --urgency-overdue and --accent-text", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const theme of ["light", "dark"] as const) {
    for (const width of [1280, 375]) {
      test(`${theme} @${width}px: every render site of both tokens clears AA`, async ({
        browser,
      }) => {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
          deviceScaleFactor: 1, // see the DPR note in the header
        });
        await page.goto("/");

        const measured = await page.evaluate(
          ({ sites, mode }) => {
            document.documentElement.classList.toggle("dark", mode === "dark");

            const canvas = document.createElement("canvas");
            canvas.width = 1;
            canvas.height = 1;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (!ctx) throw new Error("no 2d context");
            const probe = document.createElement("div");
            document.body.appendChild(probe);

            // Painting through the canvas is what applies the engine's OKLCH ->
            // sRGB gamut mapping; reading the string back would not.
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
                fg: [number, number, number];
                bg: [number, number, number];
                tintMissing: boolean;
                colorInherited: boolean;
                box: { x: number; y: number; width: number; height: number };
              }
            > = {};

            for (const site of sites) {
              // One host per site: each site names the surface it really sits
              // on, and they are not all the same one.
              const host = document.createElement("div");
              host.className = site.host;
              host.setAttribute(
                "style",
                "position:fixed;inset:0;z-index:99999;padding:40px;display:flex;" +
                  "align-items:flex-start;",
              );
              document.body.appendChild(host);

              const el = document.createElement("span");
              el.className = site.cls;
              el.textContent = site.label;
              host.appendChild(el);

              const cs = getComputedStyle(el);
              const fg = paint(cs.color);

              // Let the ENGINE composite any translucent tint over the host
              // surface rather than parsing an alpha out of a string that may
              // not even be in rgb() syntax. Sites with no tint of their own
              // composite to the bare host colour, which is the point.
              const hostBg = getComputedStyle(host).backgroundColor;
              probe.style.backgroundColor = hostBg;
              const hostResolved = getComputedStyle(probe).backgroundColor;
              probe.style.backgroundColor = cs.backgroundColor;
              const elResolved = getComputedStyle(probe).backgroundColor;
              ctx.fillStyle = "#ffffff";
              ctx.fillRect(0, 0, 1, 1);
              ctx.fillStyle = hostResolved;
              ctx.fillRect(0, 0, 1, 1);
              ctx.fillStyle = elResolved;
              ctx.fillRect(0, 0, 1, 1);
              const bd = ctx.getImageData(0, 0, 1, 1).data;
              const bg: [number, number, number] = [bd[0] ?? 0, bd[1] ?? 0, bd[2] ?? 0];

              const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
              const r = el.getBoundingClientRect();
              out[site.name] = {
                composite: ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05),
                fg,
                bg,
                // Trap 3: a tint class Tailwind never emitted, or a host whose
                // own background class never got emitted either.
                tintMissing: site.hasTint
                  ? /rgba\(0,\s*0,\s*0,\s*0\)/.test(cs.backgroundColor)
                  : /rgba\(0,\s*0,\s*0,\s*0\)/.test(hostBg),
                colorInherited: cs.color === bodyColor,
                box: { x: r.x, y: r.y, width: r.width, height: r.height },
              };

              host.remove();
            }
            probe.remove();
            return out;
          },
          { sites: ALL, mode: theme },
        );

        // The screenshot has to be taken with the element on screen, so the
        // hosts are rebuilt one at a time for the raster pass.
        for (const site of ALL) {
          const m: Measurement | undefined = measured[site.name];
          if (!m) throw new Error(`no measurement for ${site.name}`);

          // Trap 3, asserted before the ratios: either of these makes the
          // numbers meaningless-but-passing.
          expect(
            m.tintMissing,
            `${site.name}: background resolved transparent — a class in this probe is ` +
              `not in source, so Tailwind never emitted it and this measured nothing`,
          ).toBe(false);
          expect(
            m.colorInherited,
            `${site.name}: text colour equals the body foreground — the token does not ` +
              `exist, so this measured inherited text`,
          ).toBe(false);

          const box = await page.evaluate(
            async ({ s, mode }) => {
              document.documentElement.classList.toggle("dark", mode === "dark");
              for (const stale of document.querySelectorAll("[data-thin-probe]")) stale.remove();
              const host = document.createElement("div");
              host.className = s.host;
              host.setAttribute("data-thin-probe", "");
              host.setAttribute(
                "style",
                "position:fixed;inset:0;z-index:99999;padding:40px;display:flex;" +
                  "align-items:flex-start;",
              );
              const el = document.createElement("span");
              el.className = s.cls;
              el.textContent = s.label;
              host.appendChild(el);
              document.body.appendChild(host);

              // The whole measurement is a raster of anti-aliased glyphs, so it
              // is only valid once the real font is the one being rasterised
              // and the theme toggle above has actually been painted. Without
              // this the first probe of a run samples a fallback face — it
              // reported 2.519 where a settled run reports 4.204 — and a probe
              // right after a theme flip can raster the previous theme.
              await document.fonts.ready;
              await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

              const r = el.getBoundingClientRect();
              return { x: r.x, y: r.y, width: r.width, height: r.height };
            },
            { s: site, mode: theme },
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

              // The field dominates by area, so the modal colour is the
              // background the glyphs sit on.
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

              // Trap 2: cumulative-distance thresholding at p20. A share-based
              // threshold reports the background and scores 1:1 on 11px text.
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
              return {
                ratio: ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05),
                glyph,
                bg,
              };
            },
            `data:image/png;base64,${shot.toString("base64")}`,
          );

          const hex = ([r, g, b]: [number, number, number]) =>
            `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

          rows.push(
            [
              theme.padEnd(5),
              String(width).padStart(4),
              site.token.padEnd(18),
              site.name.padEnd(30),
              `fg ${hex(m.fg)}`,
              `bg ${hex(m.bg)}`,
              `comp ${m.composite.toFixed(3)}`,
              `samp ${sampled.ratio.toFixed(3)}`,
              `glyph ${hex(sampled.glyph)}`,
              sampled.ratio < AA_SMALL_TEXT ? "  <-- UNDER 4.5" : "",
            ].join("  "),
          );

          // Soft, so one thin site does not hide the numbers for every site
          // after it. The test still fails; it fails with the whole table.
          expect
            .soft(m.composite, `${site.name} ${theme} @${width}: specified colours`)
            .toBeGreaterThanOrEqual(AA_SMALL_TEXT);
          expect
            .soft(sampled.ratio, `${site.name} ${theme} @${width}: rendered glyph pixels`)
            .toBeGreaterThanOrEqual(AA_SMALL_TEXT);
        }

        await page.close();
      });
    }
  }

  test.afterAll(() => {
    if (rows.length === 0) return;
    console.log(`\n===== thin-token contrast, DPR 1, p20 cumulative threshold =====`);
    for (const r of [...rows].sort()) console.log(r);
    console.log(`================================================================\n`);
  });
});
