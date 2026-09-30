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
  'value_not_settable',
  'snapshot_unknown',
  'permission_missing',
  'target_elevated',
  'input_busy',
  'aborted',
  'timeout',
  'screenshot_failed',
  'helper_unavailable',
  'helper_incompatible',
  'unsupported_platform',
  'invalid_argument',
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
    'This app is blocked for computer use (password managers, terminals, wmux itself). Do not retry.',
    'Ask the user to do this step themselves.',
  ],
  window_not_found: ['Call listWindows for the app and pass a window id from the result.'],
  window_not_focused: [
    'Keyboard input needs the target window in the foreground. Prefer setValue or click on an element index.',
    'The input may already have been delivered: call getAppState before retrying.',
  ],
  element_not_found: ['Call getAppState again and pick an index from the new snapshot.'],
  element_stale: [
    'The element changed since the snapshot was taken. Call getAppState and use the new index.',
  ],
  action_not_supported: ['Try click on the element, or coordinates from a screenshot.'],
  value_not_settable: ['Click the field and use type instead.'],
  snapshot_unknown: ['Snapshots expire after two minutes. Call getAppState for a fresh snapshotId.'],
  permission_missing: [
    'The operating system has not granted the permission this needs. Tell the user which permission is missing; do not retry until they confirm.',
  ],
  target_elevated: [
    'The target runs as administrator, and Windows blocks input from a normal process. Ask the user to do this step.',
  ],
  input_busy: ['Another agent holds desktop input. Wait for it to finish, then retry.'],
  aborted: ['The user stopped computer use. Do not retry; ask the user how to continue.'],
  timeout: ['The app did not answer in time. Call getAppState to check its state before retrying.'],
  screenshot_failed: ['Use mode "ax" (accessibility tree only), or retry once.'],
  helper_unavailable: ['Computer use is not available right now. Tell the user; do not loop on retries.'],
  helper_incompatible: ['The computer-use helper does not match this wmux build. Tell the user to reinstall or update wmux.'],
  unsupported_platform: ['Computer use is not supported on this operating system yet.'],
  invalid_argument: ['Fix the arguments named in the message and call again.'],
  internal: ['Retry once. If it fails again, tell the user.'],
};

export interface ComputerErrorPayload {
  code: ComputerErrorCode;
  message: string;
}

export class ComputerError extends Error {
  readonly code: ComputerErrorCode;

  constructor(code: ComputerErrorCode, message: string) {
    super(message);
    this.name = 'ComputerError';
    this.code = code;
  }

  toPayload(): ComputerErrorPayload {
    return { code: this.code, message: this.message };
  }
}

/** Renders an error for an agent: code, message, then what to do next. */
export function formatComputerError(payload: ComputerErrorPayload): string {
  const steps = COMPUTER_ERROR_NEXT_STEPS[payload.code] ?? COMPUTER_ERROR_NEXT_STEPS.internal;
  return [`computer error [${payload.code}]: ${payload.message}`, ...steps.map((s) => `- ${s}`)].join('\n');
}

/**
 * Recovers a structured error from whatever crossed the pipe RPC. The RPC
 * layer carries only a message string, so main encodes errors as
 * `[code] message` and this parses it back.
 */
export function parseComputerErrorMessage(message: string): ComputerErrorPayload {
  const match = /^\[([a-z_]+)\]\s*([\s\S]*)$/.exec(message);
  if (match && isComputerErrorCode(match[1])) {
    return { code: match[1], message: match[2] };
  }
  return { code: 'internal', message };
}

export function encodeComputerErrorMessage(payload: ComputerErrorPayload): string {
  return `[${payload.code}] ${payload.message}`;
}
