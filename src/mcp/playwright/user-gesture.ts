import type { Page } from 'playwright-core';

// ---------------------------------------------------------------------------
// CDP-powered evaluate with user gesture.
//
// This file was `anti-detection.ts` and also exported `applyAntiDetection()`,
// which patched `navigator.webdriver` to `undefined`. Nothing ever called it —
// not once in the repo's history — and it is now deleted rather than wired up.
//
// The rule it violated, which is now the design constraint: **a person logs in,
// and automation only ever runs after that.** wmux never types credentials into
// a page and never forges automation signals to get past a site's own login
// protections. Where the service has an API, the agent authenticates through
// OAuth — the user consents once in their real browser and we hold a refresh
// token, so the password never reaches the automation at all. Where it does not
// (Google Flow has no API), the agent drives a session the user already signed
// into, via the `live` Chrome backend and Chrome's own remote-debugging consent
// flow (LiveChromeClient) — permission asked and granted per connection.
//
// Signal spoofing only buys anything if you are trying to push a login past a
// site's defences, and that is precisely what we do not do.
//
// The flag it hid was not ours to hide from an init script anyway:
// `navigator.webdriver` is true because ChromeLauncher passes
// `--remote-debugging-port`, which sets it before any client attaches
// (measured on Chrome 151; `--enable-automation` makes no further difference).
//
// Re-adding signal spoofing is a decision to reopen with the owner first.
// ---------------------------------------------------------------------------

/**
 * Evaluate a JavaScript expression in the page context via CDP
 * `Runtime.evaluate`.
 *
 * @param page       - The Playwright page to evaluate in.
 * @param expression - The JavaScript expression to evaluate.
 * @param options    - Optional settings.
 * @param options.userGesture - When `true`, the evaluation is treated as if
 *   triggered by a user gesture (transient activation). Defaults to `false`
 *   to follow the principle of least privilege. Callers that genuinely need
 *   user activation (e.g. opening popups, triggering downloads) should
 *   explicitly pass `true`.
 *
 * Internally opens a CDP session and calls `Runtime.evaluate`.
 */
export async function evaluateWithGesture(
  page: Page,
  expression: string,
  options?: { userGesture?: boolean },
): Promise<any> {
  const client = await page.context().newCDPSession(page);

  try {
    const result = await client.send('Runtime.evaluate', {
      expression,
      userGesture: options?.userGesture ?? false,
      returnByValue: true,
      awaitPromise: true,
    });

    if (result.exceptionDetails) {
      const msg =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'CDP Runtime.evaluate threw an exception';
      throw new Error(msg);
    }

    return result.result.value;
  } finally {
    await client.detach().catch(() => {
      /* best-effort cleanup */
    });
  }
}
