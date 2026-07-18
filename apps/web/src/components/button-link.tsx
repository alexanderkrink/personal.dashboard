import type { VariantProps } from "class-variance-authority";
import Link, { type LinkProps } from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A link that looks and sits like a button.
 *
 * Use this instead of `<Button render={<Link />}>`, which has two failure modes
 * and no correct configuration:
 *
 *  1. **As-is**, Base UI's `Button` assumes `nativeButton: true`, and handing it
 *     an `<a>` raises. React unwinds the subtree and the route paints an empty
 *     `<main>` — header, table and empty state all silently gone. It
 *     typechecks, lints and builds; it only fails once the page is loaded.
 *  2. **With `nativeButton={false}`**, it stops raising but stamps
 *     `role="button"` on the anchor, so a control that navigates is announced
 *     as a button. That trades a visible crash for a quiet accessibility bug,
 *     which is the worse of the two.
 *
 * So this borrows the *styling* (`buttonVariants`) and nothing else. What ships
 * is a real `<a href>`: announced as a link, activated by Enter, and offering
 * "open in new tab" — while carrying the same heights, hover states and
 * `pointer-coarse:` touch target as every other button in the app.
 *
 * Generic over `RouteType` for the same reason `Link` is: `typedRoutes` infers
 * that parameter from the href *literal* at the call site, which is what lets an
 * interpolated dynamic route (`/courses/${id}`) typecheck at all.
 */
export function ButtonLink<RouteType>({
  className,
  variant,
  size,
  children,
  ...props
}: VariantProps<typeof buttonVariants> &
  Omit<LinkProps<RouteType>, "className"> & {
    className?: string;
    children?: React.ReactNode;
  }) {
  return (
    <Link className={cn(buttonVariants({ variant, size, className }))} {...props}>
      {children}
    </Link>
  );
}
