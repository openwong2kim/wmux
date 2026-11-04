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

/** The kinds of field a focused element can be (contract v1.6). */
export const PHONE_BROWSER_FOCUS_KINDS = ['text', 'password', 'email', 'number', 'tel', 'url', 'search', 'textarea', 'contenteditable'] as const;

export type PhoneBrowserFocusKind = (typeof PHONE_BROWSER_FOCUS_KINDS)[number];

/**
 * Whether the page's focused element takes typed text, and which kind of
 * field it is: the tap reply's `focus` and the stream's `focus` event. Never
 * a value, name, label, placeholder or id.
 */
export interface PhoneBrowserFocus { editable: boolean; kind?: PhoneBrowserFocusKind }

/**
 * `value` as a focus state, or null when it is not one: `editable` a boolean,
 * `kind` one of the kinds and only on an editable field. Only those two
 * fields come out, whatever else `value` carried.
 */
export function phoneBrowserFocus(value: unknown): PhoneBrowserFocus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { editable, kind } = value as { editable?: unknown; kind?: unknown };
  if (typeof editable !== 'boolean') return null;
  if (kind === undefined) return { editable };
  if (!editable || typeof kind !== 'string' || !(PHONE_BROWSER_FOCUS_KINDS as readonly string[]).includes(kind)) return null;
  return { editable, kind: kind as PhoneBrowserFocusKind };
}

/**
 * `value` as the tab a tap opened (contract v1.7), or null when it is not
 * one: `surfaceId` a string of 1 to 128 characters, and nothing else.
 */
export function phoneBrowserOpened(value: unknown): { surfaceId: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { surfaceId } = value as { surfaceId?: unknown };
  return typeof surfaceId === 'string' && surfaceId.length > 0 && surfaceId.length <= 128 ? { surfaceId } : null;
}

/** Main's tap reply as the phone gets it: a `focus` or an `opened` that is not one is left out. */
export function phoneBrowserTapReply(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result) || (!('focus' in result) && !('opened' in result))) return result;
  const { focus, opened, ...rest } = result as Record<string, unknown>;
  const checkedFocus = phoneBrowserFocus(focus);
  const checkedOpened = phoneBrowserOpened(opened);
  return { ...rest, ...(checkedFocus ? { focus: checkedFocus } : {}), ...(checkedOpened ? { opened: checkedOpened } : {}) };
}
