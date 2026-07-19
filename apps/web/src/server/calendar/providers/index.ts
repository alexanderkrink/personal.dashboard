/**
 * The provider registry (§4).
 *
 * **The only place provider implementations are enumerated.** The engine reads
 * `PROVIDERS[feed.provider]` and knows nothing else about any source, so adding
 * a second calendar backend is a file next to `ics.ts` plus one line here — and
 * a `Record<CalendarSource, …>` means the compiler, not a reviewer, is what
 * notices when a new `CalendarSource` has no implementation.
 */

import type { CalendarProvider, CalendarSource } from "@study/core";
import { icsCalendarProvider } from "./ics";

export const PROVIDERS: Record<CalendarSource, CalendarProvider> = {
  ics: icsCalendarProvider,
};

/**
 * The registry lookup, tolerating the fact that `calendar_feeds.provider` is
 * `text`. A check constraint keeps it honest today, but a row written by a
 * newer deployment and read by an older one is a real situation, and it should
 * report a bad provider rather than crash on `undefined.sync`.
 */
export function providerFor(source: string): CalendarProvider | null {
  return Object.hasOwn(PROVIDERS, source) ? (PROVIDERS[source as CalendarSource] ?? null) : null;
}
