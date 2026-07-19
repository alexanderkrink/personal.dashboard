import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  // `focus-ring` (globals.css) is PLAN's 2px azure ring + 2px transparent
  // offset. It replaces the registry's 3px 50%-alpha halo, which measured
  // 1.94:1 in light and only passed SC 1.4.11 via the border underneath it.
  // NOTE: the base deliberately sets border *width* but NOT border *colour*.
  // Every variant names its own colour instead, so each button carries exactly
  // one border-colour utility.
  //
  // It used to carry `border-transparent` here and let `outline` override it.
  // That silently did not work: both are plain single-class utilities of equal
  // specificity, so the winner is whichever Tailwind emits later, and it emits
  // `.border-transparent` (offset 27181) after `.border-input-border` (26858).
  // The outline variant's border therefore resolved to rgba(0,0,0,0) — an
  // invisible edge, not merely a low-contrast one. Typecheck, lint, unit tests
  // and a visual glance at a filled button are all blind to it.
  "group/button focus-ring inline-flex shrink-0 items-center justify-center rounded-lg border bg-clip-padding text-sm font-medium whitespace-nowrap transition-all select-none active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
        // `border-input-border`, not the decorative `border-border`: an outline
        // button's edge is the only visual boundary of a non-text UI component,
        // so WCAG 2.2 SC 1.4.11 requires 3:1 against the adjacent surface. Same
        // split Wave 1 made for inputs; the button was left behind.
        //
        // Measured from real screenshot pixels, worst case of the two adjacent
        // surfaces: 3.44:1 light, 3.08:1 dark. The dark figure is the edge
        // against the button's OWN FILL; against the page it is the roomier
        // 3.27:1. Quote the 3.08 — it is the one that governs, and it leaves
        // only 0.08 of headroom, so darkening --input-border or lightening the
        // dark `bg-input/30` fill will break SC 1.4.11. Locked by
        // e2e/control-border-contrast.spec.ts.
        outline:
          "border-input-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "border-transparent hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "border-transparent bg-destructive/10 text-destructive hover:bg-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30",
        link: "border-transparent text-primary underline-offset-4 hover:underline",
      },
      /*
       * Every size carries the 44px coarse-pointer minimum (PLAN.md "Mobile /
       * PWA & accessibility"), following the `pointer-coarse:` pattern the shell
       * already established. It is a media query, not a breakpoint, so the
       * compact 24–36px cockpit densities PLAN asks for survive untouched on any
       * mouse-driven screen however narrow — which a `sm:`-style breakpoint
       * could not have done.
       */
      size: {
        default:
          "h-8 gap-1.5 px-2.5 pointer-coarse:h-11 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs pointer-coarse:h-11 in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] pointer-coarse:h-11 in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 pointer-coarse:h-11 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8 pointer-coarse:size-11",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] pointer-coarse:size-11 in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] pointer-coarse:size-11 in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9 pointer-coarse:size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
