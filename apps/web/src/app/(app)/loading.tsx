import { Skeleton } from "@/components/ui/skeleton";

/**
 * Skeletons, not spinners (PLAN.md "States & voice"). The shapes mirror the
 * real page — a heading, a lead line, then a bordered panel of hairline rows —
 * so the layout doesn't jump when content arrives.
 */
export default function AppLoading() {
  return (
    <output aria-label="Loading" className="block">
      <div className="mb-6 space-y-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="rounded-lg border border-border bg-surface p-6 md:p-8">
        <Skeleton className="size-6 rounded-md" />
        <Skeleton className="mt-4 h-5 w-52" />
        <Skeleton className="mt-2 h-4 w-full max-w-prose" />
        <div className="mt-5 space-y-3 border-border border-t pt-5">
          {["row-1", "row-2", "row-3"].map((row) => (
            <div key={row} className="flex items-center gap-2.5">
              <Skeleton className="size-1.5 rounded-full" />
              <Skeleton className="h-4 flex-1 max-w-prose" />
            </div>
          ))}
        </div>
      </div>
    </output>
  );
}
