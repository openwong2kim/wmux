/**
 * Browser backend selection (#517, backend-choice half).
 *
 * 'builtin'  — embedded <webview> panes, full automation toolset (default).
 * 'external' — agent-driven opens are delegated to the OS default browser via
 *              shell.openExternal; wmux spawns no guest Chromium at all.
 * 'chrome'   — wmux launches the user's installed Chrome with a dedicated
 *              profile (persistent logins, separate from their daily
 *              browser) and drives it over CDP. Full automation toolset via
 *              the Playwright path; the webview RPC fallback does not apply.
 *
 * External mode is fire-and-forget by design: wmux gets no tab handle back
 * from the OS, so there is no surface, no tracking, and no deep automation.
 * Tools that need a live page fail closed with EXTERNAL_BACKEND_UNSUPPORTED
 * below — never a generic target-miss, never a silent fallback onto some
 * other builtin surface.
 */
export type BrowserBackend = 'builtin' | 'external' | 'chrome';

export const BROWSER_BACKENDS: readonly BrowserBackend[] = ['builtin', 'external', 'chrome'] as const;

export const DEFAULT_BROWSER_BACKEND: BrowserBackend = 'builtin';

export function isBrowserBackend(value: unknown): value is BrowserBackend {
  return (BROWSER_BACKENDS as readonly unknown[]).includes(value);
}

/** Stable error code — agents can match on this instead of the prose. */
export const EXTERNAL_BACKEND_UNSUPPORTED_CODE = 'EXTERNAL_BACKEND_UNSUPPORTED';

/**
 * The single contract-error message for tools that cannot work in external
 * mode. Main (browser.rpc.ts) and the MCP engine (PlaywrightEngine) both
 * import this — the prose must never fork across processes.
 */
export const EXTERNAL_BACKEND_UNSUPPORTED_MESSAGE =
  `${EXTERNAL_BACKEND_UNSUPPORTED_CODE}: browser backend is 'external': only open/navigate are supported. ` +
  `Deep automation requires the built-in backend (Settings → Browser) or the agent's own browser tooling.`;

/** Stable error code for RPC-fallback tools under the 'chrome' backend. */
export const CHROME_BACKEND_RPC_UNSUPPORTED_CODE = 'CHROME_BACKEND_RPC_UNSUPPORTED';

/**
 * Under 'chrome' every tool is expected to ride the Playwright/CDP path —
 * a webview-RPC fallback hit means page resolution failed upstream. Same
 * shared-constant discipline as the external message above.
 */
export const CHROME_BACKEND_RPC_UNSUPPORTED_MESSAGE =
  `${CHROME_BACKEND_RPC_UNSUPPORTED_CODE}: browser backend is 'chrome': this operation drives the page ` +
  `over CDP directly and has no webview fallback. If page resolution failed, open a page first with browser_open. ` +
  `If browser_open works but page tools keep failing, this MCP client may not be authorized to attach ` +
  `(CDP endpoint disclosure is first-party-only).`;

/** Result shape for a delegated (external) open/navigate. */
export interface ExternalOpenResult {
  backend: 'external';
  opened: true;
  url: string;
}
