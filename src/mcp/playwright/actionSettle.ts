// Adapted from microsoft/playwright@v1.58.2 packages/playwright-core/src/server/agent/context.ts (waitForCompletion), Apache-2.0, modified
//
// Modified: reimplemented client-side over Page events (the original runs on
// the server's progress controller); returns immediately when the action
// starts no relevant request within REQUEST_GRACE_MS; only document,
// stylesheet, script, xhr and fetch requests (or a main-frame navigation)
// count; requests starting after the collect window are ignored; a navigation
// waits for its own commit before waiting for `load`; a failed request counts
// as done; a request the page already repeats on its own (a per-page request
// baseline, or a URL starting twice in one window) is not waited for.

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

// ---------------------------------------------------------------------------
// Per-page request baseline: what the page requests on its own.
//
// A page that polls starts the same request every few hundred ms whether or
// not anyone clicks, and one landing inside the grace window would otherwise
// cost the click the whole collect window. So every page a tool resolves keeps
// a short history of when each method+URL (minus query and hash) started. A
// request is the page's own, not the action's, when the page had already
// repeated it before the action and the action fell inside that rhythm: the
// last start before the action is no older than BASELINE_SLACK periods.
// A request seen only once before has no rhythm yet and still counts. A
// request settle attributes to an action is taken back out of the history, so
// an agent repeating the same click never teaches the page a rhythm of its own.
// ---------------------------------------------------------------------------

const BASELINE_KEYS = 200;
const BASELINE_STARTS = 3;
/** A gap longer than this is not polling the user would notice as such. */
const BASELINE_MAX_PERIOD_MS = 30_000;
const BASELINE_SLACK = 1.5;

const baselines = new WeakMap<object, Map<string, number[]>>();

/**
 * Start recording the page's request rhythm. Idempotent per Page; passive (it
 * only reads request events), so it is safe on every tab, the user's included.
 */
export function trackRequestBaseline(page: Page): void {
  if (!hasEvents(page) || baselines.has(page)) return;
  const starts = new Map<string, number[]>();
  baselines.set(page, starts);
  page.on('request', (request: Request) => {
    if (!safe(() => TRACKED_TYPES.has(request.resourceType()), false)) return;
    if (safe(() => request.isNavigationRequest(), false)) return;
    const key = requestKey(request);
    const times = starts.get(key) ?? [];
    starts.delete(key); // re-insert: Map order doubles as recency for eviction
    times.push(Date.now());
    if (times.length > BASELINE_STARTS) times.shift();
    starts.set(key, times);
    if (starts.size > BASELINE_KEYS) starts.delete(starts.keys().next().value as string);
  });
}

/** Take an action's own request back out of the page's history. */
function forgetActionStart(page: Page, key: string, actionStart: number): void {
  const times = baselines.get(page)?.get(key);
  if (!times) return;
  const i = times.findIndex((t) => t >= actionStart);
  if (i !== -1) times.splice(i, 1);
}

/** Did the page already repeat this request on its own, in a rhythm the action fell inside? */
function isPageOwnRhythm(page: Page, key: string, actionStart: number): boolean {
  const before = (baselines.get(page)?.get(key) ?? []).filter((t) => t < actionStart);
  if (before.length < 2) return false;
  const last = before[before.length - 1];
  const period = last - before[before.length - 2];
  if (period <= 0 || period > BASELINE_MAX_PERIOD_MS) return false;
  return actionStart - last <= period * BASELINE_SLACK;
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
  trackRequestBaseline(page);

  const inFlight = new Set<Request>();
  // How often each URL (minus query and hash) started during this settle. A
  // URL that starts twice in one window is the page polling, not the action.
  const starts = new Map<string, number>();
  let sawRequest = false;
  let navRequest: Request | undefined;
  let committed = false;
  let wake: (() => void) | undefined;
  const actionStart = Date.now();

  const isMain = (frame: unknown) => safe(() => frame === page.mainFrame(), false);
  const onRequest = (request: Request) => {
    const navigation = safe(() => request.isNavigationRequest() && isMain(request.frame()), false);
    const tracked = safe(() => TRACKED_TYPES.has(request.resourceType()), false);
    if (!navigation && !tracked) return;
    if (navigation) {
      navRequest = request;
    } else {
      const key = requestKey(request);
      if (isPageOwnRhythm(page, key, actionStart)) return;
      forgetActionStart(page, key, actionStart);
      inFlight.add(request);
      starts.set(key, (starts.get(key) ?? 0) + 1);
    }
    sawRequest = true;
    wake?.();
  };
  const onFinished = (request: Request) => {
    // A navigation's document arriving is not its commit; that is framenavigated.
    inFlight.delete(request);
    wake?.();
  };
  const onFailed = (request: Request) => {
    inFlight.delete(request);
    if (request === navRequest && !committed) navRequest = undefined; // aborted
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
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
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
    for (const request of [...inFlight]) {
      if ((starts.get(requestKey(request)) ?? 0) > 1) inFlight.delete(request);
    }

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
    page.off('requestfinished', onFinished);
    page.off('requestfailed', onFailed);
    page.off('framenavigated', onNavigated);
  }
}

/** Method plus URL without query or hash: a poll's cache-buster is not a new request. */
function requestKey(request: Request): string {
  const url = safe(() => request.url(), '');
  const cut = url.search(/[?#]/);
  return `${safe(() => request.method(), 'GET')} ${cut === -1 ? url : url.slice(0, cut)}`;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
