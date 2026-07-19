import { WarningCircle } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { FOCUS_RING } from "@/components/shell/focus-ring";
import { cn } from "@/lib/utils";
import { SyncNowButton } from "./sync-now-button";
import { formatSyncedAgo } from "./urgency";

export interface SyncStripFeed {
  id: string;
  label: string;
  active: boolean;
  lastSyncedAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
}

/**
 * The sync status strip (§7 part 1).
 *
 * *"Synced 12 min ago · 2 feeds ok"* plus **Sync now**, degrading to a warning
 * chip **carrying the feed's label** on error. The label matters: with more than
 * one feed connected, "sync failed" does not tell you which subscription to go
 * and re-copy.
 *
 * A revoked ICS token is called out by name, because it is the one failure the
 * user can actually fix and the fix is not obvious — "unauthorized" reads as our
 * bug, "Reconnect" reads as the instruction it is. The engine's
 * `describeSyncError` already writes that sentence; this reads its shape.
 *
 * 🔒 No feed URL reaches this component. It takes a label and a status, never a
 * config object.
 */
export function SyncStrip({ feeds, now }: { feeds: readonly SyncStripFeed[]; now: Date }) {
  if (feeds.length === 0) {
    return (
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border border-dashed bg-surface px-3 py-2 text-muted-foreground text-ui-sm">
        <span>No calendar feed connected yet.</span>
        <Link
          href="/calendar"
          className={cn("text-accent-text underline-offset-2 hover:underline", FOCUS_RING)}
        >
          Connect one
        </Link>
      </div>
    );
  }

  const active = feeds.filter((feed) => feed.active);
  const failing = active.filter((feed) => feed.lastSyncStatus === "error");
  // The oldest successful sync is the honest headline: with two feeds, "synced
  // 2 min ago" is a lie if the other one last succeeded yesterday.
  const oldest = active.reduce<string | null>((oldestAt, feed) => {
    if (feed.lastSyncedAt === null) return oldestAt;
    if (oldestAt === null) return feed.lastSyncedAt;
    return feed.lastSyncedAt < oldestAt ? feed.lastSyncedAt : oldestAt;
  }, null);

  const healthy = active.length - failing.length;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-surface px-3 py-2">
      <p className="text-muted-foreground text-ui-sm">
        <span className="font-mono tabular-nums">Synced {formatSyncedAgo(oldest, now)}</span>
        <span aria-hidden="true"> · </span>
        {healthy} {healthy === 1 ? "feed" : "feeds"} ok
        {feeds.length > active.length ? (
          <>
            <span aria-hidden="true"> · </span>
            {feeds.length - active.length} paused
          </>
        ) : null}
      </p>

      {failing.map((feed) => {
        // The engine writes "reconnect the feed with a fresh URL" for a 401.
        const revoked = (feed.lastSyncError ?? "").toLowerCase().includes("reconnect");
        return (
          <span
            key={feed.id}
            className="inline-flex items-center gap-1.5 rounded-4xl bg-urgency-overdue/10 px-2 py-0.5 text-urgency-overdue-text text-ui-xs dark:bg-urgency-overdue/20"
          >
            <WarningCircle weight="fill" aria-hidden="true" className="size-3.5" />
            <span className="font-medium">{feed.label}</span>
            <span aria-hidden="true">·</span>
            {revoked ? "Reconnect" : "Sync failed"}
          </span>
        );
      })}

      {/* One feed is the real case; syncing the first active one is what this
          button has ever meant. Per-feed buttons live on the feed table below. */}
      <SyncNowButton
        feedId={active[0]?.id ?? feeds[0]?.id ?? ""}
        label={active[0]?.label ?? feeds[0]?.label ?? ""}
      />
    </div>
  );
}
