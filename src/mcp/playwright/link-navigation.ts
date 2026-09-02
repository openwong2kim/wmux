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
// The script runs in the isolated world for the same reason everything else
// does (see isolated-eval.ts): page code must not be able to watch it.
// ---------------------------------------------------------------------------

import type { Page, Response } from 'playwright-core';
import { evaluateIsolated } from './isolated-eval';

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
 * Navigate `page` to `url` the way following a link would, and wait for the
 * result exactly as `page.goto` does.
 *
 * Resolves with the main resource's response (null for a same-document move),
 * and rejects with the navigation's own error — a dead host, a crashed page, a
 * timeout — because `waitForNavigation` propagates `navigated.error` and the
 * navigation timeout the same way `goto` does. Callers therefore keep goto's
 * error handling; what changes is only how the request is issued.
 */
export async function navigateFromPage(page: Page, url: string): Promise<Response | null> {
  // Armed BEFORE the navigation is triggered, so the commit cannot land in the
  // gap between the two calls.
  const navigated = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  // If the evaluation below throws, nothing awaits `navigated` and its eventual
  // timeout would surface as an unhandled rejection. Attaching a sink here does
  // not swallow it for the `await` further down — that still sees the original
  // promise.
  navigated.catch(() => undefined);

  await evaluateIsolated(page, ASSIGN, url);
  return await navigated;
}
