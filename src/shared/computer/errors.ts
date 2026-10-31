// Computer-use error taxonomy, shared by main, the MCP tool and (by contract)
// both native helpers. Helpers classify failures by stable identifiers
// (HRESULTs, AXError values), never by localized message text, and report one
// of these codes. `nextSteps` is appended to the MCP error text so the agent
// recovers instead of retrying the same call unchanged.

export const COMPUTER_ERROR_CODES = [
  'app_not_found',
  'app_blocked',
  'window_not_found',
  'window_not_focused',
  'element_not_found',
  'element_stale',
  'action_not_supported',
  'unsupported_action',
  'value_not_settable',
  'snapshot_unknown',
  'permission_missing',
  'target_elevated',
  'input_busy',
  'shortcut_blocked',
  'stop_key_unavailable',
  'aborted',
  'timeout',
  'screenshot_failed',
  'helper_unavailable',
  'helper_incompatible',
  'turned_off',
  'shutting_down',
  'unsupported_platform',
  'invalid_argument',
  'policy_denied',
  'internal',
] as const;

export type ComputerErrorCode = (typeof COMPUTER_ERROR_CODES)[number];

const CODE_SET: ReadonlySet<string> = new Set(COMPUTER_ERROR_CODES);

export function isComputerErrorCode(value: unknown): value is ComputerErrorCode {
  return typeof value === 'string' && CODE_SET.has(value);
}

export const COMPUTER_ERROR_NEXT_STEPS: Record<ComputerErrorCode, readonly string[]> = {
  app_not_found: ['Call listApps and use an app name or id exactly as listed.'],
  app_blocked: [
    'This app is blocked for computer use (password managers, wmux itself, system sign-in and administrator prompts). Do not retry.',
    'Ask the user to do this step themselves.',
  ],
  window_not_found: ['Call listWindows for the app and pass a window id from the result.'],
  window_not_focused: [
    'Keyboard input needs the target window in the foreground. Prefer setValue or click on an element index.',
  ],
  element_not_found: ['Call getAppState again and pick an index from the new snapshot.'],
  element_stale: [
    'The element changed since the snapshot was taken. Call getAppState and use the new index.',
  ],
  action_not_supported: ['Try click on the element, or coordinates from a screenshot.'],
  unsupported_action: [
    'This computer-use helper cannot do that action. Use listApps and getAppState instead, or ask the user to open the app.',
  ],
  value_not_settable: ['Click the field and use type instead.'],
  snapshot_unknown: ['Snapshots expire after two minutes. Call getAppState for a fresh snapshotId.'],
  permission_missing: [
    'The operating system has not granted the permission this needs. Tell the user which permission is missing and pass on the steps in the message; do not retry until they confirm.',
  ],
  target_elevated: [
    'The target runs as administrator, and Windows blocks input from a normal process. Ask the user to do this step.',
  ],
  input_busy: ['Another agent holds desktop input. Wait for it to finish, then retry.'],
  shortcut_blocked: [
    'This shortcut locks the screen, logs out or force-quits apps. Do not retry it.',
    'Reach the goal inside the app (click an element, use its menus), or ask the user to do this step.',
  ],
  stop_key_unavailable: [
    'Input is refused while the emergency stop key is unavailable. Tell the user: another app is using the shortcut shown in Settings › Computer use; closing it lets wmux take the key on the next call.',
    'Observation (listApps, getAppState) still works. Do not loop on retries.',
  ],
  aborted: ['The user stopped computer use. Do not retry; ask the user how to continue.'],
  timeout: [
    'The app, or the user on a consent prompt, did not answer in time. Call getAppState to check the app\'s state before retrying.',
    'An unanswered consent prompt is not a refusal: tell the user what you need, then call again to ask once more.',
  ],
  screenshot_failed: ['Use mode "ax" (accessibility tree only), or retry once.'],
  helper_unavailable: ['Computer use is not available right now. Tell the user; do not loop on retries.'],
  helper_incompatible: ['The computer-use helper does not match this wmux build. Tell the user to reinstall or update wmux.'],
  turned_off: [
    'The user has turned computer use off. Do not retry until they turn it back on in Settings › Computer use; ask them if you need it.',
  ],
  shutting_down: [
    'wmux is quitting or restarting its computer-use helper. Nothing is wrong with the install; do not loop on retries.',
    'If wmux is still running, call again once; otherwise tell the user the step was cut off.',
  ],
  unsupported_platform: ['Computer use is not supported on this operating system yet.'],
  invalid_argument: ['Fix the arguments named in the message and call again.'],
  policy_denied: [
    "This pane's browser is protected, so computer use is refused from it. Do not retry unchanged.",
    "Use the browser_* tools for this pane's own sites, or ask the user to do this step.",
  ],
  internal: ['Retry once (after getAppState when the disposition says input may have reached the app). If it fails again, tell the user.'],
};

/**
 * Whether an input action may be retried. `not_delivered`: refused before any
 * input was sent, so retrying cannot repeat anything. `delivered_unverified`:
 * input was sent (or may have been) and its effect was not read back, so a
 * retry could do it twice. `delivered`: sent and its effect read back. A
 * posting call that returned without error is no proof of delivery: neither
 * OS acknowledges an event it dropped. Results and errors of input actions
 * both carry it; main fills it in where a helper leaves it out
 * (protocol ActionResult).
 */
export type ActionDisposition = 'not_delivered' | 'delivered_unverified' | 'delivered';

export const ACTION_DISPOSITIONS: readonly ActionDisposition[] = ['not_delivered', 'delivered_unverified', 'delivered'];

export function isActionDisposition(value: unknown): value is ActionDisposition {
  return typeof value === 'string' && (ACTION_DISPOSITIONS as readonly string[]).includes(value);
}

export interface ComputerErrorPayload {
  code: ComputerErrorCode;
  message: string;
  /** Set on input actions (protocol ActionDisposition). */
  disposition?: ActionDisposition;
}

export class ComputerError extends Error {
  readonly code: ComputerErrorCode;
  readonly disposition?: ActionDisposition;

  constructor(code: ComputerErrorCode, message: string, disposition?: ActionDisposition) {
    super(message);
    this.name = 'ComputerError';
    this.code = code;
    if (disposition) this.disposition = disposition;
  }

  toPayload(): ComputerErrorPayload {
    return { code: this.code, message: this.message, ...(this.disposition && { disposition: this.disposition }) };
  }
}

/**
 * The error an input action ends with: `err` as a ComputerError carrying a
 * disposition, `fallback` when it had none. Another error keeps a code it can
 * be told by (a TimeoutError or AbortError), otherwise it is `internal`.
 */
export function withDisposition(err: unknown, fallback: ActionDisposition): ComputerError {
  if (err instanceof ComputerError) {
    return err.disposition ? err : new ComputerError(err.code, err.message, fallback);
  }
  const name = err instanceof Error ? err.name : '';
  const code: ComputerErrorCode = name === 'TimeoutError' ? 'timeout' : name === 'AbortError' ? 'aborted' : 'internal';
  return new ComputerError(code, err instanceof Error ? err.message : String(err), fallback);
}

/**
 * The error an input action of one or more helper requests ends with.
 * `requested`: one of its requests went to the helper. `earlier`: one already
 * came back done, so input went out before this failure, and a
 * `not_delivered` from the failing request is no longer true of the action.
 */
export function inputActionError(err: unknown, requested: boolean, earlier: boolean): ComputerError {
  const error = withDisposition(err, requested ? 'delivered_unverified' : 'not_delivered');
  return earlier && error.disposition === 'not_delivered'
    ? new ComputerError(error.code, error.message, 'delivered_unverified')
    : error;
}

const DISPOSITION_TEXT: Record<ActionDisposition, string> = {
  not_delivered: 'not_delivered (no input was sent; retrying is safe)',
  delivered_unverified: 'delivered_unverified (input may have reached the app; call getAppState before retrying)',
  delivered: 'delivered',
};

/** Renders an error for an agent: code, message, disposition, then what to do next. */
export function formatComputerError(payload: ComputerErrorPayload): string {
  const steps = COMPUTER_ERROR_NEXT_STEPS[payload.code] ?? COMPUTER_ERROR_NEXT_STEPS.internal;
  return [
    `computer error [${payload.code}]: ${payload.message}`,
    ...(payload.disposition ? [`disposition: ${DISPOSITION_TEXT[payload.disposition]}`] : []),
    ...steps.map((s) => `- ${s}`),
  ].join('\n');
}

/**
 * Recovers a structured error from whatever crossed the pipe RPC. The RPC
 * layer carries only a message string, so main encodes errors as
 * `[code] message`, with ` [disposition:<value>]` at the end for an input
 * action (a parser that predates it still reads the code), and this parses
 * it back.
 */
export function parseComputerErrorMessage(message: string): ComputerErrorPayload {
  // Only a known disposition is a suffix; anything else stays in the message.
  const match = /^\[([a-z_]+)\]\s*([\s\S]*?)(?: \[disposition:(not_delivered|delivered_unverified|delivered)\])?$/.exec(message);
  if (match && isComputerErrorCode(match[1])) {
    return { code: match[1], message: match[2], ...(isActionDisposition(match[3]) && { disposition: match[3] }) };
  }
  return { code: 'internal', message };
}

export function encodeComputerErrorMessage(payload: ComputerErrorPayload): string {
  return `[${payload.code}] ${payload.message}${payload.disposition ? ` [disposition:${payload.disposition}]` : ''}`;
}
