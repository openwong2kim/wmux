/**
 * Browser backend selection (#517, backend-choice half).
 *
 * 'builtin'  — embedded <webview> panes, full automation toolset (default).
 * 'external' — agent-driven opens are delegated to the OS default browser via
 *              shell.openExternal; wmux spawns no guest Chromium at all.
 *
 * External mode is fire-and-forget by design: wmux gets no tab handle back
 * from the OS, so there is no surface, no tracking, and no deep automation.
 * Tools that need a live page fail closed with EXTERNAL_BACKEND_UNSUPPORTED
 * below — never a generic target-miss, never a silent fallback onto some
 * other builtin surface.
 */
export type BrowserBackend = 'builtin' | 'external';

export const BROWSER_BACKENDS: readonly BrowserBackend[] = ['builtin', 'external'] as const;

export const DEFAULT_BROWSER_BACKEND: BrowserBackend = 'builtin';

export function isBrowserBackend(value: unknown): value is BrowserBackend {
  return value === 'builtin' || value === 'external';
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

/** Result shape for a delegated (external) open/navigate. */
export interface ExternalOpenResult {
  backend: 'external';
  opened: true;
  url: string;
}
