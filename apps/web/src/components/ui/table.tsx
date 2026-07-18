"use client";

import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * `containerClassName` styles the scroll container, not the `<table>`.
 *
 * This exists to make one specific pattern possible: a **sticky header**. A
 * `sticky` `thead` sticks to its nearest scrolling ancestor, and containing the
 * horizontal scroll (below) makes this wrapper that ancestor. The wrapper has no
 * height constraint, so it never scrolls vertically and a sticky `thead` has
 * nothing to stick to — the page scrolls instead and the header rides away with
 * it. "Sticky header" and "contained horizontal scroll" are therefore mutually
 * exclusive *unless* this container is also the vertical scroller.
 *
 * So sticky headers require exactly this, and only where row count is unbounded:
 *
 *   <Table containerClassName="max-h-[60vh] overflow-y-auto">
 *     <TableHeader className="sticky top-0 z-10 bg-surface">
 *
 * Bounded tables (a term's courses, a week of deadlines, one course's grade
 * components) should NOT do this: capping their height adds a second scrollbar
 * and hides rows that would otherwise all be visible. They get no sticky header,
 * which costs nothing because the whole table fits on screen.
 */
function Table({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<"table"> & { containerClassName?: string }) {
  return (
    <div
      data-slot="table-container"
      className={cn("relative w-full overflow-x-auto", containerClassName)}
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("border-t bg-muted/50 font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn("p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0", className)}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow };
