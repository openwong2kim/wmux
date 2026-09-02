// ---------------------------------------------------------------------------
// Navigating FROM the page, rather than to it.
//
// `shared/referer.ts` decides when a navigation should carry a Referer. Sending
// it through `page.goto(url, { referer })` is what a browser never does: goto
// is an address-bar navigation, so Chromium also sends `Sec-Fetch-Site: none`
// and `Sec-Fetch-User: ?1` — "the user typed this in" — while the Referer says
// "I followed a link from that page". Measured live, a page reached this way
// arrived with `Referer: https://previous.example/` next to
// `Sec-Fetch-Site: none`, a pair no browser produces. The header meant to make
// the traffic look ordinary was the thing that marked it.
//
// The fix is not a different header, it is a different navigation. Running
// `location.assign(url)` inside the page makes Chromium itself classify the
// navigation as script-initiated from that document, so it fills in the whole
// set consistently: the Referer under the current referrer policy, a real
// `Sec-Fetch-Site` (cross-site / same-origin / same-site), `Sec-Fetch-Mode:
// navigate`, and no `Sec-Fetch-User` — because no user gesture was involved.
//
// The script runs in the isolated world, and ONLY there: a page that could see
// this script could hook `setTimeout` or `location.assign` and either stall the
// navigation or send it somewhere of its own choosing.
// ---------------------------------------------------------------------------

import type { Page, Response } from 'playwright-core';
import { evaluateIsolated } from './isolated-eval';

/**
 * How long to wait for the in-page navigation to COMMIT before giving up on it.
 *
 * Not the navigation's own timeout — this is only the window in which Chromium
 * has to acknowledge that the assignment started a navigation at all. The
 * default (30 s, page-wide) meant a target that never commits — a download
 * response, a 204, a page that blocks the assignment — stalled for half a
 * minute and then let the caller issue the SAME url a second time through
 * goto: two downloads, or a one-time token spent twice. Chromium commits a
 * navigation it accepted in milliseconds, so a few seconds is generous.
 */
const COMMIT_TIMEOUT_MS = 4000;

/**
 * Ask the document to navigate itself, one task later.
 *
 * Deferred rather than called inline so the evaluation has certainly returned
 * before the navigation tears its execution context down: a `callFunctionOn`
 * that loses that race comes back as "Execution context was destroyed", which
 * `evaluateIsolated` treats as a stale context and RETRIES — a second
 * navigation, this time from the page we just arrived at.
 */
const ASSIGN = (target: string): void => {
  window.setTimeout(() => {
    window.location.assign(target);
  }, 0);
};

/**
 * The in-page route never started a navigation — the page blocked the
 * assignment, or the target is something Chromium does not commit as a
 * document. The caller may retry by another route; no request of ours reached
 * the network.
 */
export class NavigationNotCommittedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NavigationNotCommittedError';
  }
}

/** Errors that mean the navigation was attempted and genuinely failed. */
function isRealNavigationFailure(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /net::ERR_|ERR_ABORTED|Navigation failed because|frame was detached|Target (page|closed)/i.test(
    text,
  );
}

export interface FromPageNavigation {
  /** The main resource's response; null for a same-document move. */
  response: Response | null;
}

/**
 * Navigate `page` to `url` the way following a link would.
 *
 * Resolves once the navigation has committed, with the main resource's
 * response. Rejects with the navigation's own error when the navigation was
 * really attempted and failed (a dead host, a detached frame) — those are the
 * caller's to report, not to retry. Rejects with `NavigationNotCommittedError`
 * when nothing started within `COMMIT_TIMEOUT_MS`, which is the only case where
 * retrying by another route is safe: no request went out.
 */
export async function navigateFromPage(page: Page, url: string): Promise<FromPageNavigation> {
  const before = page.url();

  // Armed BEFORE the navigation is triggered, so the commit cannot land in the
  // gap between the two calls. The URL predicate is what makes this OUR
  // navigation: `waitForNavigation` resolves on any main-frame commit, so a
  // page's own meta-refresh or scripted redirect could otherwise satisfy the
  // wait, hand back a URL we never asked for, and leave our assignment to fire
  // afterwards into a document that had already moved.
  const navigated = page.waitForNavigation({
    waitUntil: 'domcontentloaded',
    timeout: COMMIT_TIMEOUT_MS,
    url: (candidate) => candidate.toString() !== before,
  });
  // If the evaluation below throws, nothing awaits `navigated` and its eventual
  // timeout would surface as an unhandled rejection. Attaching a sink here does
  // not swallow it for the `await` further down — that still sees the original
  // promise.
  navigated.catch(() => undefined);

  try {
    await evaluateIsolated(page, ASSIGN, url, { requireIsolated: true });
  } catch (error) {
    throw new NavigationNotCommittedError(
      `the page could not be asked to navigate: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    return { response: await navigated };
  } catch (error) {
    if (isRealNavigationFailure(error)) throw error;
    // The wait ran out. If the document moved anyway — a commit that raced the
    // predicate — that IS our navigation and the caller must not repeat it.
    if (page.url() !== before) return { response: null };
    throw new NavigationNotCommittedError(
      `no navigation committed within ${COMMIT_TIMEOUT_MS}ms of the assignment`,
    );
  }
}
