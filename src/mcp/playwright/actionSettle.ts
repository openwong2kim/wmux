// Adapted from microsoft/playwright@v1.58.2 packages/playwright-core/src/server/agent/context.ts (waitForCompletion), Apache-2.0, modified
//
// Modified: reimplemented client-side over Page events (the original runs on
// the server's progress controller), returns immediately when the action
// starts no request within REQUEST_GRACE_MS, ignores non-page-state
// resource types, treats a failed request as done, and stops waiting the
// moment a dialog or file chooser opens (modalState).

import type { Page, Request } from 'playwright-core';
import { delayUnlessModal, raceModal, type RaceOutcome } from './modalState';

/** No request inside this window after the action means there is nothing to wait for. */
export const REQUEST_GRACE_MS = 100;
/** Once traffic started: how long requests may keep starting before we look at them. */
export const COLLECT_WINDOW_MS = 500;
/** The ceiling on everything settle waits for after the action itself. */
export const SETTLE_CAP_MS = 5_000;

// What a page's next state depends on. An image, a beacon or a ping does not
// change what a snapshot will show, and analytics pings would otherwise turn
// every click into a 500ms one.
const TRACKED_TYPES = new Set(['document', 'stylesheet', 'script', 'xhr', 'fetch']);

type EventPage = Pick<Page, 'on' | 'off' | 'mainFrame' | 'waitForLoadState'>;

function hasEvents(page: unknown): page is EventPage {
  const p = page as Partial<EventPage> | null | undefined;
  return !!p && typeof p.on === 'function' && typeof p.off === 'function';
}

function sleep(page: Page, ms: number): Promise<void> {
  return ms > 0 ? delayUnlessModal(page, ms) : Promise.resolve();
}

/**
 * Run `fn` (one dispatched page action) and wait until the page has caught up
 * with it, so the next snapshot shows the state the action produced:
 *   - no request within REQUEST_GRACE_MS of the action -> return at once;
 *   - otherwise keep collecting until COLLECT_WINDOW_MS after the action, then
 *     wait for `load` if the main frame navigated, else for every tracked
 *     request to finish or fail;
 *   - never longer than SETTLE_CAP_MS past the action, and never past a modal
 *     opening (the action is reported, the modal is answered next).
 *
 * Every wait swallows its own failure: settling is a courtesy, and a page that
 * closed or navigated mid-wait must never turn a dispatched action into a
 * failed one. `fn`'s own rejection is the only error that escapes.
 */
export async function settleAfterAction<T>(page: Page, fn: () => Promise<T>): Promise<RaceOutcome<T>> {
  if (!hasEvents(page)) return { interrupted: false, value: await fn() };

  const inFlight = new Set<Request>();
  let sawRequest = false;
  let navigated = false;
  let firstRequest: (() => void) | undefined;
  let allDone: (() => void) | undefined;
  const onRequest = (request: Request) => {
    sawRequest = true;
    try {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigated = true;
      if (TRACKED_TYPES.has(request.resourceType())) inFlight.add(request);
    } catch {
      /* request torn down with its frame */
    }
    firstRequest?.();
  };
  const onDone = (request: Request) => {
    inFlight.delete(request);
    if (inFlight.size === 0) allDone?.();
  };

  page.on('request', onRequest);
  page.on('requestfinished', onDone);
  page.on('requestfailed', onDone);
  try {
    const outcome = await raceModal(page, fn());
    if (outcome.interrupted) return outcome;
    const actedAt = Date.now();

    if (!sawRequest) {
      await raceModal(
        page,
        new Promise<void>((resolve) => {
          firstRequest = resolve;
          const t = setTimeout(resolve, REQUEST_GRACE_MS);
          (t as { unref?: () => void }).unref?.();
        }),
      );
      firstRequest = undefined;
      if (!sawRequest) return outcome;
    }

    await sleep(page, COLLECT_WINDOW_MS - (Date.now() - actedAt));
    const remaining = SETTLE_CAP_MS - (Date.now() - actedAt);
    if (remaining <= 0) return outcome;

    let capTimer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>((resolve) => {
      capTimer = setTimeout(resolve, remaining);
      (capTimer as { unref?: () => void }).unref?.();
    });
    try {
      const target = navigated
        ? page.waitForLoadState('load', { timeout: remaining }).catch(() => {})
        : inFlight.size === 0
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              allDone = resolve;
            });
      await raceModal(page, Promise.race([target, cap]));
    } finally {
      if (capTimer) clearTimeout(capTimer);
      allDone = undefined;
    }
    return outcome;
  } finally {
    page.off('request', onRequest);
    page.off('requestfinished', onDone);
    page.off('requestfailed', onDone);
  }
}
