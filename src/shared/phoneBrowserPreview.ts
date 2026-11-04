// ─── The phone's workspace browser preview on a wmux Chrome profile
//
// The preview (GET/POST …/browser, docs/phone-client-contract.md "Workspace
// browser preview") drives builtin browser panes. A desktop that announces
// BROWSER_CHROME_PREVIEW_CAPABILITY also drives tabs of a DEDICATED wmux Chrome
// profile, for a phone that opts in with `GET …/browser?chrome=1`. Live Chrome
// (the user's own browser) is never listed and never driven.
//
// Main answers the codes below inside a successful bridge reply
// (`{error:<code>}`); the daemon maps each to its status. Every other failure
// stays the generic 503 `browser-preview-unavailable` it was before.

/** Announced at `daemon.phone.register`: this desktop previews dedicated Chrome tabs. */
export const BROWSER_CHROME_PREVIEW_CAPABILITY = 'browser.chromePreview';

/**
 * Announced at `daemon.phone.register`: this desktop streams a preview tab.
 * The daemon then marks forwarded input `stream:true`, and main answers that
 * input by the stream's rules (the keys and `history` below, the size-only
 * scroll check, and the 409 codes).
 */
export const BROWSER_STREAM_CAPABILITY = 'browser.stream';

/** Keys a phone may press beyond the base list, only on input marked `stream:true`. */
export const BROWSER_STREAM_KEYS: readonly string[] = ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','Delete'];

/** Which browser a preview row is. */
export type PhoneBrowserBackend = 'builtin' | 'chrome';

export const PHONE_BROWSER_ERROR_STATUS = {
  /** No browser to drive: the setting does not allow it, or Chrome's socket is not up. */
  'browser-backend-unavailable': 503,
  /** The tab did not answer in time; usually a background tab Chrome stopped painting. */
  'browser-tab-hidden': 409,
  /** The tab closed, moved to another workspace, or Chrome replaced it. */
  'browser-tab-gone': 404,
  /** This action does not exist for this backend (viewport emulation on Chrome). */
  'browser-action-unsupported': 501,
  /** Help-card typing: the tab's origin is not the one the help request showed. */
  'browser-help-origin-changed': 409,
  /** Help-card typing: no open request with that id for this tab. */
  'browser-help-not-found': 404,
  /** Help-card typing: that request already ended. */
  'browser-help-closed': 409,
  /** Stream input: another input on this tab is still running. Nothing was applied. */
  'browser-input-busy': 409,
  /** Stream input: the viewport no longer matches the geometry sent. Nothing was applied. */
  'browser-viewport-changed': 409,
  /** Stream tap or history: `expectedURL` is an earlier URL of the page now showing. Nothing was applied. */
  'browser-page-changed': 409,
} as const;

export type PhoneBrowserErrorCode = keyof typeof PHONE_BROWSER_ERROR_STATUS;

export function isPhoneBrowserErrorCode(value: unknown): value is PhoneBrowserErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PHONE_BROWSER_ERROR_STATUS, value);
}

/** A failure main answers with its code rather than the generic one. */
export class PhoneBrowserError extends Error {
  constructor(public readonly code: PhoneBrowserErrorCode) {
    super(code);
  }
}
