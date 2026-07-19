import type { MetadataRoute } from "next";

/**
 * Web app manifest. Scope is deliberately the manifest alone — service worker, offline
 * and push are item 9's job, not this file's.
 *
 * Colours are the MEASURED sRGB the browser paints for the dark-theme tokens, matching
 * `icon.svg`. `--background` is `oklch(0.13 0.012 237)`, which rasterises to `#04080b`;
 * the comment in globals.css says `~#0b0e14`, which is the design intent rather than what
 * the browser actually paints. The manifest has to agree with the pixels, so it uses the
 * measured value — otherwise the Android status bar and the splash screen sit a visible
 * step lighter than the app they frame.
 *
 * The app defaults to the dark cockpit theme (`ThemeProvider defaultTheme="dark"`), so
 * `theme_color` is the dark canvas rather than the light one.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Alex's Study Dashboard",
    short_name: "Study",
    description: "Your entire academic life in one dashboard.",
    start_url: "/",
    display: "standalone",
    background_color: "#04080b",
    theme_color: "#04080b",
    icons: [
      {
        // Displayed unmasked, so this one keeps the plate's own 20% corner radius.
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        // Full-bleed: Android applies its own mask, and a baked-in radius double-rounds.
        // The dot is not scaled down — at 43.75% of the canvas it already sits entirely
        // inside the 80%-diameter safe circle.
        src: "/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
