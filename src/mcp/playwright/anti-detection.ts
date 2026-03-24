import type { Page } from 'playwright-core';

// ---------------------------------------------------------------------------
// Anti-detection helpers
// ---------------------------------------------------------------------------

/**
 * Apply anti-detection measures to the page via init scripts.
 *
 * Currently patches `navigator.webdriver` to return `undefined` so that
 * common bot-detection scripts do not flag the session.
 */
export async function applyAntiDetection(page: Page): Promise<void> {
  await page.context().addInitScript(() => {
    // Override navigator.webdriver to hide automation flag
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
  });
}

// ---------------------------------------------------------------------------
// CDP-powered evaluate with user gesture
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
