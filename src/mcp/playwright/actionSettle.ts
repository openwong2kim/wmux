// Adapted from microsoft/playwright@v1.58.2 packages/playwright-core/src/server/agent/context.ts (waitForCompletion), Apache-2.0, modified
//
// Modified: reimplemented client-side over Page events (the original runs on
// the server's progress controller); returns immediately when the action
// starts no relevant request within REQUEST_GRACE_MS; only document,
// stylesheet, script, xhr and fetch requests (or a main-frame navigation)
// count; requests starting after the collect window are ignored; a navigation
// waits for its own commit before waiting for `load`; a failed request counts
// as done.

import type { Page, Request } from 'playwright-core';
import { beginDispatch } from './modalState';

/** No relevant request inside this window after the action means there is nothing to wait for. */
export const REQUEST_GRACE_MS = 100;
/** Once traffic started: how long new requests are still collected, from the action's end. */
export const COLLECT_WINDOW_MS = 500;
/** The ceiling on everything settle waits for after the action itself. */
export const SETTLE_CAP_MS = 5_000;

// What a page's next state depends on. An image, a beacon or a ping does not
// change what a snapshot will show, and must not cost a click 500ms.
const TRACKED_TYPES = new Set(['document', 'stylesheet', 'script', 'xhr', 'fetch']);

type EventPage = Pick<Page, 'on' | 'off' | 'mainFrame' | 'waitForLoadState'>;

function hasEvents(page: unknown): page is EventPage {
  const p = page as Partial<EventPage> | null | undefined;
  return !!p && typeof p.on === 'function' && typeof p.off === 'function';
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

/**
 * Run `fn` (one dispatched page action) and wait until the page has caught up
 * with it, so the next snapshot shows the state the action produced:
 *   - no relevant request within REQUEST_GRACE_MS of the action -> return;
 *   - otherwise collect requests until COLLECT_WINDOW_MS after the action,
 *     then wait for the navigation to commit and reach `load` if the main
 *     frame navigated, else for every collected request to finish or fail;
 *   - never longer than SETTLE_CAP_MS past the action.
 *
 * Every wait swallows its own failure: settling is a courtesy, and a page that
 * closed mid-wait must never turn a dispatched action into a failed one — nor
 * a failed one into a success. `fn`'s own rejection is the only error out.
 */
export async function settleAfterAction<T>(page: Page, fn: () => Promise<T>): Promise<T> {
  if (!hasEvents(page)) return fn();

  const inFlight = new Set<Request>();
  let sawRequest = false;
  let navRequest: Request | undefined;
  let committed = false;
  let wake: (() => void) | undefined;

  const isMain = (frame: unknown) => safe(() => frame === page.mainFrame(), false);
  const onRequest = (request: Request) => {
    const navigation = safe(() => request.isNavigationRequest() && isMain(request.frame()), false);
    const tracked = safe(() => TRACKED_TYPES.has(request.resourceType()), false);
    if (!navigation && !tracked) return;
    sawRequest = true;
    if (navigation) navRequest = request;
    else inFlight.add(request);
    wake?.();
  };
  const onDone = (request: Request) => {
    inFlight.delete(request);
    if (request === navRequest && !committed) navRequest = undefined; // aborted or replaced
    wake?.();
  };
  const onNavigated = (frame: unknown) => {
    if (!isMain(frame)) return;
    committed = true;
    wake?.();
  };
  /** Resolve on the next event that might change the answer, or after `ms`. */
  const nextEvent = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, Math.max(0, ms));
      (t as { unref?: () => void }).unref?.();
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    }).finally(() => {
      wake = undefined;
    });

  page.on('request', onRequest);
  page.on('requestfinished', onDone);
  page.on('requestfailed', onDone);
  page.on('framenavigated', onNavigated);
  let collecting = true;
  const stopCollecting = () => {
    if (!collecting) return;
    collecting = false;
    page.off('request', onRequest);
  };
  try {
    const endDispatch = beginDispatch(page);
    let value: T;
    try {
      value = await fn();
    } finally {
      endDispatch();
    }
    const actedAt = Date.now();
    const left = () => SETTLE_CAP_MS - (Date.now() - actedAt);

    if (!sawRequest) {
      await nextEvent(REQUEST_GRACE_MS);
      if (!sawRequest) return value;
    }
    await sleep(COLLECT_WINDOW_MS - (Date.now() - actedAt));
    // A polling page keeps starting requests; only the action's are waited for.
    stopCollecting();

    if (navRequest) {
      // Wait for THIS navigation to commit first: `load` read before the
      // commit is the old document's, already reached.
      while (navRequest && !committed && left() > 0) await nextEvent(left());
      if (committed && left() > 0) {
        await page.waitForLoadState('load', { timeout: left() }).catch(() => undefined);
      }
      return value;
    }
    while (inFlight.size > 0 && left() > 0) await nextEvent(left());
    return value;
  } finally {
    stopCollecting();
    page.off('requestfinished', onDone);
    page.off('requestfailed', onDone);
    page.off('framenavigated', onNavigated);
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
