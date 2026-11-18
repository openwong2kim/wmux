/**
 * T4 — renderer IPC adapter hook.
 *
 * Normalises arbitrary IPC calls (e.g. `window.electronAPI.pty.create(...)`)
 * into a discriminated `IpcResult<T>`. On failure it reads the `code` that
 * `wrapHandler` (T3a/T3b) attached on the main-side error, maps it to a
 * localized user message, and optionally pushes a UI toast.
 *
 * Design notes:
 *   - Returns `{ invoke }` rather than auto-invoking so call-sites retain
 *     control over when the call fires (side-effects, deps, etc.).
 *   - Never re-throws — callers branch on `result.ok`.
 *   - Toast push goes through the toast store; if the store is absent
 *     (pre-wiring, standalone tests), it falls back to `console.warn`.
 */
import { useMemo } from 'react';
import { useStore } from '../stores';
import { t } from '../i18n';
import type { TranslationKey } from '../i18n/locales/en';

export type IpcErrorCode =
  | 'DAEMON_DISCONNECTED'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'RESOURCE_EXHAUSTED'
  | 'UNKNOWN';

const KNOWN_CODES: ReadonlySet<IpcErrorCode> = new Set<IpcErrorCode>([
  'DAEMON_DISCONNECTED',
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'UNKNOWN',
]);

/**
 * Matches a `[CODE] ` token written by `wrapHandler` in the main process.
 * Electron's IPC serializer drops own properties on `Error` instances
 * (`err.code` included) AND wraps the message itself — what arrives
 * here typically looks like:
 *   `Error invoking remote method 'pty:create': Error: [CODE] <orig msg>`
 * so the token is NOT anchored to the start of the string. The
 * alternation only matches known codes, so a literal `[UNKNOWN]` token
 * elsewhere in user content is the only theoretical false positive — and
 * if our own wrapHandler stamped it, classifying as UNKNOWN is correct
 * anyway. Keep the wrapHandler-side regex anchored (`^`) because there
 * the message starts with our stamp; only the renderer needs the looser
 * match because Electron prepends the invoke envelope.
 *
 * v2.8.2 fix — pre-v2.8.2 the renderer regex was also anchored, so
 * RESOURCE_EXHAUSTED (and every other coded error) silently fell
 * through to UNKNOWN whenever Electron wrapped the message, which
 * was the common case.
 */
const MESSAGE_CODE_PREFIX =
  /\[(DAEMON_DISCONNECTED|VALIDATION_ERROR|NOT_FOUND|PERMISSION_DENIED|RESOURCE_EXHAUSTED|UNKNOWN)\] /;

export interface IpcErrorShape {
  code: IpcErrorCode;
  message: string;
  original?: unknown;
}

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: IpcErrorShape };

export interface UseIpcOptions {
  /** Auto-show a toast when an IPC call rejects. Default: true. */
  toastOnError?: boolean;
  /** Override the default user-facing message per error code. */
  messages?: Partial<Record<IpcErrorCode, string>>;
  /** Error codes that should NOT trigger a toast (e.g. expected NOT_FOUND). */
  silent?: IpcErrorCode[];
}

/** Resolve at failure time so an existing invoke follows locale changes. */
const DEFAULT_MESSAGE_KEYS: Record<IpcErrorCode, TranslationKey> = {
  DAEMON_DISCONNECTED: 'ipc.error.daemonDisconnected',
  VALIDATION_ERROR: 'ipc.error.validation',
  NOT_FOUND: 'ipc.error.notFound',
  PERMISSION_DENIED: 'ipc.error.permissionDenied',
  RESOURCE_EXHAUSTED: 'ipc.error.resourceExhausted',
  UNKNOWN: 'ipc.error.unknown',
};

/** Map an error code to a toast level. */
const CODE_TO_LEVEL: Record<IpcErrorCode, 'info' | 'warn' | 'error'> = {
  DAEMON_DISCONNECTED: 'warn',
  VALIDATION_ERROR: 'warn',
  NOT_FOUND: 'info',
  PERMISSION_DENIED: 'error',
  RESOURCE_EXHAUSTED: 'warn',
  UNKNOWN: 'error',
};

function classifyCode(err: unknown): IpcErrorCode {
  // Primary path — `wrapHandler` attaches `err.code` in the main
  // process, and the renderer sees it here when Electron's IPC
  // serializer preserves own properties.
  if (err && typeof err === 'object' && 'code' in err) {
    const raw = (err as { code?: unknown }).code;
    if (typeof raw === 'string' && KNOWN_CODES.has(raw as IpcErrorCode)) {
      return raw as IpcErrorCode;
    }
  }
  // Fallback — if the own property was stripped during serialization
  // we look for the `[CODE] ` prefix that `wrapHandler` also stamped
  // into the message. This lets us still classify past a
  // frozen/stripped error boundary.
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string') {
      const match = MESSAGE_CODE_PREFIX.exec(msg);
      if (match && KNOWN_CODES.has(match[1] as IpcErrorCode)) {
        return match[1] as IpcErrorCode;
      }
    }
  }
  return 'UNKNOWN';
}

/**
 * Refusals whose own sentence is the message: the code alone would say "An
 * unknown error occurred." and drop what to do. #2388: a pane refused in a
 * task folder whose removal did not finish names the folder and the ways out.
 */
// A missing Rust terminal core (shared/terminalPty TerminalCoreMissingError)
// says why and to reinstall: there is no other engine to fall back to.
const OWN_SENTENCE_REFUSALS: readonly RegExp[] = [
  /a task folder whose removal did not finish/,
  /wmux's terminal core is missing or failed to load/,
];

/** The main-side sentence of such a refusal, without Electron's envelope or
 *  wrapHandler's code token; null for any other error. */
function ownSentence(err: unknown): string | null {
  const raw = extractMessage(err);
  if (!OWN_SENTENCE_REFUSALS.some((re) => re.test(raw))) return null;
  const coded = MESSAGE_CODE_PREFIX.exec(raw);
  const body = coded
    ? raw.slice(coded.index + coded[0].length)
    : raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
  return body.trim() || null;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return String(err);
  } catch {
    return '';
  }
}

/** Push a toast via the store, or fall back to console.warn if unavailable. */
function surfaceToast(message: string, level: 'info' | 'warn' | 'error'): void {
  try {
    const state = useStore.getState();
    if (state && typeof (state as { pushToast?: unknown }).pushToast === 'function') {
      (state as unknown as { pushToast: (t: { message: string; level: 'info' | 'warn' | 'error' }) => string })
        .pushToast({ message, level });
      return;
    }
  } catch {
    // Store may not be initialised (e.g. SSR/tests) — fall through.
  }
  // Fallback — keep it visible in dev but don't interrupt flow.
  // TODO(T4-followup): replace with a proper logger once one is chosen.
  // eslint-disable-next-line no-console
  console.warn('[useIpc] toast fallback:', level, message);
}

export interface UseIpcReturn {
  invoke: <T>(call: () => Promise<T>) => Promise<IpcResult<T>>;
}

/**
 * Pure factory — builds an `invoke` function from a set of options.
 *
 * Exported separately so it can be unit-tested without a React renderer
 * (vitest runs in node/jsdom-less mode in this project).
 */
export function createInvoke(
  opts: UseIpcOptions | undefined,
  toastSink: (message: string, level: 'info' | 'warn' | 'error') => void,
): UseIpcReturn['invoke'] {
  const toastOnError = opts?.toastOnError ?? true;
  const silent = new Set<IpcErrorCode>(opts?.silent ?? []);
  const overrides = opts?.messages ?? {};

  return async function invoke<T>(call: () => Promise<T>): Promise<IpcResult<T>> {
    try {
      const data = await call();
      return { ok: true, data };
    } catch (err: unknown) {
      const code = classifyCode(err);
      const message = ownSentence(err) ?? overrides[code] ?? t(DEFAULT_MESSAGE_KEYS[code]);
      const error: IpcErrorShape = {
        code,
        message,
        original: err,
      };

      if (toastOnError && !silent.has(code)) {
        toastSink(message, CODE_TO_LEVEL[code]);
      }

      // Low-noise diagnostic trace — visible in devtools, not the UI.
      // eslint-disable-next-line no-console
      console.warn('[useIpc] ipc_error', { code, reason: extractMessage(err) });

      return { ok: false, error };
    }
  };
}

export function useIpc(opts?: UseIpcOptions): UseIpcReturn {
  // Memoise on the option primitives so the returned `invoke` is stable
  // across renders when options don't change.
  const toastOnError = opts?.toastOnError ?? true;
  const silentKey = (opts?.silent ?? []).slice().sort().join('|');
  const messagesKey = opts?.messages ? JSON.stringify(opts.messages) : '';

  return useMemo<UseIpcReturn>(() => {
    const invoke = createInvoke(opts, surfaceToast);
    return { invoke };
  }, [toastOnError, silentKey, messagesKey]);
}
