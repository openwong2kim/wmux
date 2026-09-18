// ─── browser_request_help — the wire shapes shared by all four layers ────────
//
// One module because the same record crosses four boundaries: the MCP tool
// (over the pipe), the main-process store, the preload bridge, and the renderer
// slice. Keeping the shapes here rather than type-importing the main-process
// class means the renderer never reaches into `src/main` for a wire contract it
// also has to validate.
//
// The prompt is AGENT-AUTHORED and untrusted: it is rendered as text only, and
// `sanitizeHelpPrompt` is the single place its shape is decided (control chars
// out, length capped) so the tool, the RPC handler and the renderer cannot
// disagree about what a legal prompt is.

/** Lifecycle of one help request. `pending` is the only non-terminal state. */
export type BrowserHelpState =
  | 'pending'
  | 'completed'
  | 'continued'
  | 'cancelled'
  | 'timed_out';

/**
 * Conditions that auto-complete a request without the human pressing Done.
 *
 * Both are evaluated in the TOP frame only. That is a real limitation for the
 * very cases this feature exists for — a CAPTCHA widget, a 3-D Secure step and
 * an SSO OTP field usually live in a cross-origin iframe — so `selector` is
 * documented as top-frame in the tool schema rather than quietly never holding.
 * `urlIncludes` is the condition that works across those flows, because the
 * frame that matters is the one the flow eventually navigates the tab to.
 */
export interface BrowserHelpCompletion {
  /** Substring the top-frame URL must contain. */
  urlIncludes?: string;
  /** CSS selector that must resolve to an element in the top frame. */
  selector?: string;
}

/** The open-request payload pushed to the renderer over BROWSER_HELP_OPEN. */
export interface BrowserHelpRequestInfo {
  requestId: string;
  /** The workspace that asked. Scoping key for status/cancel. */
  workspaceId: string;
  /** The browser surface the request is about; absent when none resolved. */
  surfaceId?: string;
  /** Agent-authored, already sanitized. Render as TEXT, never as markup. */
  prompt: string;
  /** Snapshot ref main outlined in the page, when one was asked for. */
  ref?: string;
  /** Epoch ms after which main settles the request as `timed_out`. */
  deadlineAt: number;
}

/** What the human pressed. `completed` and `timed_out` are never human. */
export type BrowserHelpOutcome = 'continued' | 'cancelled';

export const BROWSER_HELP_PROMPT_MAX_CHARS = 500;
export const BROWSER_HELP_DEFAULT_TIMEOUT_MS = 300_000;
export const BROWSER_HELP_MAX_TIMEOUT_MS = 900_000;
/**
 * A floor, not a courtesy: a request the human cannot physically reach is not a
 * hand-off, and a deadline that can fire before the outline is even drawn leaves
 * a red box on a page whose request is already over.
 */
export const BROWSER_HELP_MIN_TIMEOUT_MS = 5_000;
/** Completion polling cadence, and how long the condition must hold. */
export const BROWSER_HELP_POLL_MS = 500;
export const BROWSER_HELP_HOLD_MS = 1_000;

/**
 * Codepoints that occupy no visible width, or that a terminal / notification
 * renderer would act on rather than draw. Enumerated as a predicate rather than
 * a character-class regex so the source itself stays free of literal control
 * characters (a regex literal containing a raw newline does not even parse).
 */
function isInvisibleCodePoint(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0xfeff
  );
}

/**
 * The one legal shape of an agent-authored prompt.
 *
 * Control characters are replaced rather than escaped: this string lands in a
 * one-line band in the wmux window and in an OS notification body, and a
 * newline or an ANSI escape there is a way to make the band say something the
 * agent did not visibly write. Returns an empty string for anything unusable,
 * which the callers treat as a refusal.
 */
export function sanitizeHelpPrompt(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const stripped = Array.from(raw, (ch) => (isInvisibleCodePoint(ch.codePointAt(0) ?? 0) ? ' ' : ch)).join('');
  return stripped.replace(/\s+/g, ' ').trim().slice(0, BROWSER_HELP_PROMPT_MAX_CHARS);
}

/** Clamp a caller-supplied deadline into the documented window. */
export function clampHelpTimeoutMs(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return BROWSER_HELP_DEFAULT_TIMEOUT_MS;
  }
  return Math.min(
    Math.max(Math.floor(raw), BROWSER_HELP_MIN_TIMEOUT_MS),
    BROWSER_HELP_MAX_TIMEOUT_MS,
  );
}

/**
 * Accept a snapshot ref only in the alphabet a `[data-wmux-ref="…"]` selector
 * can carry. Same guard as the tool layer's `sanitizeRef` (see
 * src/mcp/playwright/tools/interaction.ts) — restated rather than imported
 * because main must not depend on the MCP bundle, and a ref reaching main has
 * already crossed a process boundary, so it is re-checked where it is
 * interpolated.
 */
export function isHelpRef(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[a-zA-Z0-9_-]+$/.test(raw);
}

/**
 * Outline the ref'd element, mirroring `browser_highlight`'s RPC fallback
 * (3px solid red + 2px offset). Returns 'ok' or 'not_found' so the caller can
 * tell the agent whether the highlight it asked for actually landed.
 *
 * The previous inline styles are stashed on the element so
 * `buildHelpUnhighlightExpression` can put them back instead of blanking
 * styles the page itself set.
 */
export function buildHelpHighlightExpression(ref: string): string {
  // Interpolated bare, exactly as browser_highlight does: `isHelpRef` has
  // already confined the ref to [A-Za-z0-9_-], which cannot close the selector
  // or the enclosing string.
  return `(() => {
    const el = document.querySelector('[data-wmux-ref="${ref}"]');
    if (!el) return 'not_found';
    el.dataset.wmuxHelpOutline = el.style.outline + '|' + el.style.outlineOffset;
    el.style.outline = '3px solid red';
    el.style.outlineOffset = '2px';
    return 'ok';
  })()`;
}

/** Undo `buildHelpHighlightExpression`. Never throws on a departed element. */
export function buildHelpUnhighlightExpression(ref: string): string {
  return `(() => {
    const el = document.querySelector('[data-wmux-ref="${ref}"]');
    if (!el) return 'gone';
    const saved = el.dataset.wmuxHelpOutline;
    if (typeof saved === 'string') {
      const parts = saved.split('|');
      el.style.outline = parts[0] || '';
      el.style.outlineOffset = parts[1] || '';
      delete el.dataset.wmuxHelpOutline;
    }
    return 'ok';
  })()`;
}

/**
 * Read the page URL and evaluate the completion condition in ONE round trip.
 *
 * One expression rather than two calls because the two answers have to describe
 * the same instant: a URL read taken after a selector check could report the
 * page the flow navigated to while claiming the pre-navigation element was
 * still there.
 */
export function buildHelpProbeExpression(completion?: BrowserHelpCompletion): string {
  const urlIncludes = completion?.urlIncludes;
  const selector = completion?.selector;
  const urlTest =
    typeof urlIncludes === 'string' && urlIncludes.length > 0
      ? `href.includes(${JSON.stringify(urlIncludes)})`
      : 'true';
  const selectorTest =
    typeof selector === 'string' && selector.length > 0
      ? `!!document.querySelector(${JSON.stringify(selector)})`
      : 'true';
  const hasAny =
    (typeof urlIncludes === 'string' && urlIncludes.length > 0) ||
    (typeof selector === 'string' && selector.length > 0);
  return `(() => {
    const href = location.href;
    return { url: href, matched: ${hasAny ? `Boolean(${urlTest} && ${selectorTest})` : 'false'} };
  })()`;
}

/** Shape `buildHelpProbeExpression` resolves to. */
export interface BrowserHelpProbe {
  url?: string;
  matched?: boolean;
}
