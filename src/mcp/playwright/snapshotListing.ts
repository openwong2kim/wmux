/**
 * A side channel carrying the COMPLETE snapshot listing out of a snapshot
 * handler, for a caller that needs the whole element inventory even when the
 * text it gets back is a diff.
 *
 * `browser_repl` is that caller. The script's `browser.snapshot()` value is
 * read twice over: once by whoever prints `.text` (a diff is the saving the
 * auto-diff exists for) and once by code doing `refs.find(...)` (a diff is a
 * listing with most of the elements missing). The bridge used to reconcile
 * those by forcing `full:true` on every in-script snapshot — ~78KB and 7-8s
 * per act-then-verify iteration, paid so that a `find` would not miss an
 * unchanged element.
 *
 * The handler already holds both halves: `text` is the full listing and
 * `formatSnapshotResult` decides what to return. Publishing the full listing
 * here lets the bridge parse a complete `refs[]` off it while the returned
 * text stays a diff. AsyncLocalStorage rather than a module global for the
 * reason connectionScope.ts gives: the broker hosts N callers in one process,
 * and two concurrent snapshots must not read each other's listing.
 *
 * Nothing is published when no capture is active, so a direct MCP call pays
 * neither the bytes nor the bookkeeping.
 */
import { AsyncLocalStorage } from 'async_hooks';

interface ListingSink {
  listing?: string;
}

const storage = new AsyncLocalStorage<ListingSink>();

/**
 * Publish the complete listing the current snapshot was rendered from.
 * A no-op outside a capture, and cheap enough to call unconditionally.
 */
export function captureSnapshotListing(text: string): void {
  const sink = storage.getStore();
  if (sink) sink.listing = text;
}

/**
 * Run `fn` with a capture active. `listing` is the last complete listing a
 * snapshot handler published inside it, or undefined when it published none
 * (an error before the render, or a tool that is not a snapshot) — callers
 * treat that as "no better source than the returned text".
 */
export async function withSnapshotListingCapture<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; listing: string | undefined }> {
  const sink: ListingSink = {};
  const result = await storage.run(sink, fn);
  return { result, listing: sink.listing };
}
