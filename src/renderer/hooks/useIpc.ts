/**
 * T4 — renderer IPC adapter hook.
 *
 * Normalises arbitrary IPC calls (e.g. `window.electronAPI.pty.create(...)`)
 * into a discriminated `IpcResult<T>`. On failure it reads the `code` that
 * `wrapHandler` (T3a/T3b) attached on the main-side error, maps it to a
 * localized-ish user message, and optionally pushes a UI toast.
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

/** Default, user-facing messages (Korean, to match the rest of the UI). */
const DEFAULT_MESSAGES: Record<IpcErrorCode, string> = {
  DAEMON_DISCONNECTED: 'daemon이 응답하지 않습니다. 재시도 중…',
  VALIDATION_ERROR: '요청이 유효하지 않습니다.',
  NOT_FOUND: '항목을 찾을 수 없습니다.',
  PERMISSION_DENIED: '권한이 거부되었습니다.',
  RESOURCE_EXHAUSTED: '터미널 세션 한도에 도달했습니다. 일부 pane을 닫거나 wmux를 재시작한 뒤 다시 시도해주세요.',
  UNKNOWN: '알 수 없는 오류가 발생했습니다.',
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
      const message = overrides[code] ?? DEFAULT_MESSAGES[code];
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toastOnError, silentKey, messagesKey]);
}
