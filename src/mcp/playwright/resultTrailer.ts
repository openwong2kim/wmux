/**
 * Machine-readable effect trailer for the mutating browser tools.
 *
 * Every mutating tool already says what happened in prose, and prose is the
 * one thing an agent cannot act on after a timeout: "locator.click: Timeout
 * 30000ms exceeded" does not say whether the click went out. So the agent
 * retries — a second submit on a form that already posted — or gives up on a
 * flow that actually worked. That ambiguity is not hypothetical: it is why
 * `browser_file_upload` already carries a hand-written duplicate-upload warning
 * on a measured timeout (see describeUploadTimeout in tools/file.ts), and why
 * `browser_download` puts the tab back when its click navigated instead. Both
 * of those are one tool telling one caller in prose; this is the same answer
 * for all of them, in a form a caller can branch on.
 *
 * So the results of the tools that put INPUT on a page end with two lines the
 * agent can branch on:
 *
 *   effect_state: none | committed | unknown
 *   error_code: <code>            (error results only)
 *
 * That is browser_click, browser_type, browser_fill, browser_press_key,
 * browser_hover, browser_drag, browser_select, browser_scroll,
 * browser_scroll_into_view, browser_navigate, browser_navigate_back,
 * browser_file_upload, browser_download and browser_dialog. Tools that change
 * something OTHER than the page's own state — browser_evaluate, browser_tabs,
 * browser_open/close, browser_emulate, browser_resize, browser_highlight, the
 * cookie and storage writes — are not covered yet; extending the contract to
 * them is a follow-up, not a reason to word it as if they were.
 *
 * `none` means nothing was dispatched and a retry is free. `committed` means
 * the input reached the page. `unknown` means a dispatch went out and its
 * outcome cannot be read from here, which is the only case where the agent has
 * to look at the page before doing anything else.
 *
 * The prose is left exactly as it was: the trailer is appended, never a
 * replacement, so a caller that reads the first line keeps reading the same
 * first line.
 *
 * Read-only tools (snapshot, screenshot, extract, console, network, cookie and
 * storage reads, wait) carry NO trailer — they have no effect to report, and a
 * trailer on them would train the agent to read one where it means nothing.
 *
 * Mechanism credit: reporting a tool's side-effect state as a machine-readable
 * trailer so the caller can tell a retryable failure from an ambiguous one;
 * Tencent/BrowserSkill (MIT) and jackwener/opencli (Apache-2.0) referenced as
 * prior art. No code copied.
 */

/** What a mutating tool did to the page, as far as this process can verify. */
export const EFFECT_STATES = ['none', 'committed', 'unknown'] as const;

export type EffectState = (typeof EFFECT_STATES)[number];

/**
 * The CLOSED set of failure codes a mutating tool may report.
 *
 * Closed on purpose: the agent branches on these, and a code invented at one
 * failure site is a code no caller can have a rule for. A site that cannot be
 * classified reports `unknown_error` rather than a new name.
 */
export const TOOL_ERROR_CODES = [
  'invalid_params',
  'ref_not_found',
  'selector_not_found',
  'scope_refused',
  'element_not_visible',
  'element_not_interactable',
  'timeout',
  'navigation_interrupted',
  'transport_lost',
  'not_supported',
  'dialog_blocked',
  'unknown_error',
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

/**
 * The sentence an `unknown` result carries in its own text.
 *
 * The trailer is for the agent that reads trailers; this is for the one that
 * reads the error and retries. Both have to say the same thing or the contract
 * only half exists.
 */
export const UNKNOWN_EFFECT_ADVICE =
  'Inspect the page before retrying — the action may already have taken effect.';

/** One short sentence per mutating tool description, so the agent looks. */
export const EFFECT_TRAILER_NOTE =
  ' Ends with effect_state: committed | none | unknown — read it before retrying.';

export interface EffectTrailer {
  readonly effect: EffectState;
  /** Omitted on success; every error result carries one. */
  readonly code?: ToolErrorCode;
}

/** The trailer lines themselves, in their fixed order. */
export function effectTrailerLines(trailer: EffectTrailer): string {
  const lines = [`effect_state: ${trailer.effect}`];
  if (trailer.code) lines.push(`error_code: ${trailer.code}`);
  return lines.join('\n');
}

/**
 * A trailer already present on a text block, so appending twice cannot happen.
 *
 * Anchored at the END of the block, where a trailer always sits. Unanchored, a
 * `browser_type` echo of an agent-supplied value — the one mutating result that
 * quotes text somebody else wrote — could carry these words mid-string and
 * suppress the real trailer.
 */
const TRAILER_PRESENT = /(?:^|\n)effect_state: (?:none|committed|unknown)(?:\nerror_code: [a-z_]+)?$/;

/** The shape of a tool result this helper can append to. */
interface TrailerableResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/**
 * Append the trailer to `result` and return it.
 *
 * The LAST text block is the one extended, because the automation lease
 * prepends its `[browser events]` and hint blocks (see automationLease.ts) —
 * so the trailer stays the last thing in the result no matter what the lease
 * adds around it.
 *
 * A result with no text block at all gets one: a trailer that is silently
 * dropped for an image-only result would be a contract with a hole in it.
 */
export function withEffectTrailer<R extends TrailerableResult>(
  result: R,
  trailer: EffectTrailer,
): R {
  const blocks = Array.isArray(result.content) ? result.content : null;
  if (!blocks) return result;
  let last: { type: string; text?: string } | undefined;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]?.type === 'text' && typeof blocks[i].text === 'string') {
      last = blocks[i];
      break;
    }
  }
  if (last?.text && TRAILER_PRESENT.test(last.text)) return result;
  const advice =
    trailer.effect === 'unknown' && !(last?.text ?? '').includes(UNKNOWN_EFFECT_ADVICE)
      ? `\n${UNKNOWN_EFFECT_ADVICE}`
      : '';
  const appended = `${advice}\n\n${effectTrailerLines(trailer)}`;
  if (last) last.text = `${last.text}${appended}`;
  else blocks.push({ type: 'text', text: appended.trimStart() });
  return result;
}

/**
 * The code (and, where a branch knows better, the state) a failure site
 * declared for itself. Stored on the error rather than inferred from its
 * wording: the message is written for a human reader and may be reworded any
 * day, while the code is a contract.
 *
 * Symbol.for rather than a module-local symbol so a tag survives two copies of
 * this module in one process — a mismatch there would silently downgrade every
 * tagged failure to a guess.
 */
const EFFECT_TAG = Symbol.for('wmux.browserEffectTag');

interface EffectTag {
  readonly code: ToolErrorCode;
  /**
   * Set only where the branch can prove the state the dispatch probe would get
   * wrong — a page evaluation that reached the page, decided the ref was gone
   * and changed nothing, for instance.
   */
  readonly effect?: EffectState;
}

/** An Error carrying the code the trailer should report for it. */
export function taggedFailure(
  code: ToolErrorCode,
  message: string,
  effect?: EffectState,
): Error {
  const error = new Error(message);
  // Non-enumerable: the tag must never reach a log line, a JSON dump or the
  // agent — it is already reported as `error_code`.
  Object.defineProperty(error, EFFECT_TAG, {
    value: { code, ...(effect && { effect }) } satisfies EffectTag,
    enumerable: false,
  });
  return error;
}

export function effectTagOf(error: unknown): EffectTag | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const tag = (error as Record<symbol, unknown>)[EFFECT_TAG];
  if (!tag || typeof tag !== 'object') return undefined;
  const code = (tag as { code?: unknown }).code;
  if (typeof code !== 'string' || !(TOOL_ERROR_CODES as readonly string[]).includes(code)) {
    return undefined;
  }
  return tag as EffectTag;
}

/**
 * Failures that carry no tag, keyed by the wording they are raised with.
 *
 * A backstop, not the mechanism: the sites whose code matters are tagged at the
 * throw (see taggedFailure). What lands here is what wmux does not raise
 * itself — Playwright's own errors, the RPC transport's, and main's refusals —
 * where there is nothing to tag and the message is the only evidence there is.
 *
 * Order is the classification: the first match wins, so the specific patterns
 * (a scope refusal, a lost connection) are asked before the generic ones. A
 * Playwright timeout message carries its whole call log, which mentions
 * visibility and enablement, so `timeout` is asked before either of those —
 * the thing that failed is the wait, not the element.
 */
const MESSAGE_CODES: ReadonlyArray<readonly [RegExp, ToolErrorCode]> = [
  [
    /WORKSPACE_SCOPE_UNRESOLVED|BROWSER_SCOPE_REFUSED|BROWSER_NO_OWN_SURFACE|BROWSER_SURFACE_NOT_REGISTERED/,
    'scope_refused',
  ],
  [
    /wmux is not running|wmux auth token not found|Connection error:|Connection closed before response/,
    'transport_lost',
  ],
  [/Timeout\b|Timed out|TimeoutError/i, 'timeout'],
  [
    /Execution context was destroyed|because of a navigation|frame (?:was |got )?detached|Target (?:closed|crashed)|page (?:was |has been )?closed/i,
    'navigation_interrupted',
  ],
  [
    /No browser page available|need a live browser page|cannot be used on this transport|Unknown method|does not support|mouse-only|Modifier keys are held for mouse gestures only/,
    'not_supported',
  ],
  [/ref=|Could not resolve ref|No file input found at or near/, 'ref_not_found'],
  [/No element matches selector|No file input element/, 'selector_not_found'],
  [/dialog/i, 'dialog_blocked'],
  [/not visible/i, 'element_not_visible'],
  [
    /not enabled|not editable|not an <input|not a <select|not a native <select|intercepts pointer events|is disabled/i,
    'element_not_interactable',
  ],
];

/** The code for an untagged failure, or `unknown_error` when nothing fits. */
export function toolErrorCodeFor(error: unknown): ToolErrorCode {
  const tagged = effectTagOf(error);
  if (tagged) return tagged.code;
  const message = error instanceof Error ? error.message : String(error);
  for (const [pattern, code] of MESSAGE_CODES) {
    if (pattern.test(message)) return code;
  }
  return 'unknown_error';
}

/**
 * The trailer for a caught failure.
 *
 * `dispatched` is the whole of the state decision and it comes from the tool
 * body, not from the message: a failure raised before any input went out is
 * `none` whatever it says, and one raised after is `unknown` even when the
 * wording sounds harmless. A branch that can prove otherwise overrides it
 * through its tag.
 */
export function classifyToolFailure(
  error: unknown,
  opts: { readonly dispatched: boolean },
): { effect: EffectState; code: ToolErrorCode } {
  const code = toolErrorCodeFor(error);
  const override = effectTagOf(error)?.effect;
  return { effect: override ?? (opts.dispatched ? 'unknown' : 'none'), code };
}

/**
 * Tracks whether a tool body got as far as dispatching anything.
 *
 * One per tool invocation. Every site that puts input on the page — a
 * Playwright call, a CDP RPC, a page evaluation that mutates — runs through
 * `dispatch` (or announces itself with `begin`), and the flag is raised BEFORE
 * the call rather than after: a call that never came back is exactly the case
 * the trailer exists for.
 *
 * The invariant is one-directional, so getting it wrong fails loudly rather
 * than quietly: an unmarked dispatch makes a successful call report
 * `effect_state: none`, which contradicts its own prose.
 */
export interface EffectProbe {
  /** Has anything been sent to the page? */
  readonly dispatched: boolean;
  /** Mark a dispatch that is not shaped like a single awaited call. */
  begin(): void;
  /** Run `send`, counting it as dispatched from before it is awaited. */
  dispatch<T>(send: () => Promise<T>): Promise<T>;
  /** The trailer for a result that succeeded. */
  success(): EffectTrailer;
  /** The trailer for a caught failure. */
  failure(error: unknown): EffectTrailer;
}

export function createEffectProbe(): EffectProbe {
  let dispatched = false;
  return {
    get dispatched() {
      return dispatched;
    },
    begin() {
      dispatched = true;
    },
    dispatch<T>(send: () => Promise<T>): Promise<T> {
      dispatched = true;
      return send();
    },
    success() {
      // A success with nothing dispatched is not a contradiction everywhere:
      // browser_fill with an empty field list has nothing to send, and says so.
      return { effect: dispatched ? 'committed' : 'none' };
    },
    failure(error: unknown) {
      return classifyToolFailure(error, { dispatched });
    },
  };
}
