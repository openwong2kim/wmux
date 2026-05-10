/**
 * T3a — IPC handler wrapper.
 *
 * Goal: wrap `ipcMain.handle` callbacks so that any thrown error is
 *   1) classified into a coarse `IpcErrorCode`,
 *   2) emitted as a single-line structured JSON log to stderr,
 *   3) re-thrown so the renderer still sees a native promise rejection.
 *
 * Non-goals (deliberately deferred):
 *   - `{ok, data, error}` response normalization (handled in renderer
 *     `useIpc` hook — T4).
 *   - Correlation IDs / distributed tracing.
 *   - External logging library integration.
 */

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
 * Matches a leading `[CODE] ` prefix written by the wrapper so we can
 * detect that a message has already been stamped (avoids double-stamping
 * if a handler is wrapped twice). Only the main-side regex is anchored
 * because we're matching against our own raw output here. The
 * renderer-side regex in `useIpc.ts` deliberately drops the anchor —
 * Electron wraps the message envelope (`Error invoking remote method
 * '...': Error: <msg>`) before it reaches the renderer, so the stamp
 * is no longer at the start.
 */
const MESSAGE_CODE_PREFIX =
  /^\[(DAEMON_DISCONNECTED|VALIDATION_ERROR|NOT_FOUND|PERMISSION_DENIED|RESOURCE_EXHAUSTED|UNKNOWN)\] /;

export interface StructuredLogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  event: 'ipc_error' | 'ipc_success';
  channel: string;
  error_code?: IpcErrorCode;
  stack?: string;
  args_summary?: string;
}

const ARGS_SUMMARY_CAP = 200;
const SENSITIVE_KEY_PATTERN = /(password|token|secret|key|authorization|auth)/i;

/** Heuristic classification of an unknown error into one of the known codes. */
function classifyError(err: unknown): IpcErrorCode {
  // Preserve explicit `code` property on the error if it is one of our known codes.
  if (err && typeof err === 'object' && 'code' in err) {
    const maybe = (err as { code?: unknown }).code;
    if (typeof maybe === 'string' && KNOWN_CODES.has(maybe as IpcErrorCode)) {
      return maybe as IpcErrorCode;
    }
  }

  const message = err instanceof Error ? err.message : String(err ?? '');
  const lower = message.toLowerCase();

  // Daemon disconnected / not connected / pipe closed.
  if (
    (lower.includes('daemon') && (lower.includes('not connected') || lower.includes('disconnected'))) ||
    lower.includes('daemon not connected') ||
    lower.includes('daemon disconnected') ||
    lower.includes('daemon is not connected')
  ) {
    return 'DAEMON_DISCONNECTED';
  }

  // Daemon session cap reached. Phrasing comes from
  // `DaemonSessionManager.createSession` — keep this matcher in sync.
  // Without classification the renderer would surface a generic
  // "알 수 없는 오류" toast, which hides the actionable instruction
  // (close some panes / restart wmux) that the daemon attached.
  if (
    lower.includes('cannot create new terminal') &&
    lower.includes('active sessions already running')
  ) {
    return 'RESOURCE_EXHAUSTED';
  }

  return 'UNKNOWN';
}

/** Recursively redact values whose key matches the sensitive pattern. 1-depth only. */
function redactShallow(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    // Arrays: preserve structure but redact nothing at this level (no keys).
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Build a short, privacy-aware summary of the first argument.
 * Caps at 200 chars and truncates with `...` if longer.
 */
export function buildArgsSummary(args: readonly unknown[]): string | undefined {
  if (args.length === 0) return undefined;
  const first = args[0];
  let raw: string;
  try {
    const redacted = redactShallow(first);
    raw = JSON.stringify(redacted);
  } catch {
    // Circular structure / BigInt / etc — fall back to String().
    try {
      raw = String(first);
    } catch {
      return '[unserializable]';
    }
  }
  if (raw === undefined) return undefined;
  if (raw.length <= ARGS_SUMMARY_CAP) return raw;
  return raw.slice(0, ARGS_SUMMARY_CAP) + '...';
}

/** Emit a single JSON line to stderr. Fire-and-forget; never throws. */
function emit(entry: StructuredLogEntry): void {
  try {
    process.stderr.write(JSON.stringify(entry) + '\n');
  } catch {
    /* no-op — logging must not break handlers */
  }
}

/**
 * Wrap an ipcMain handler callback with structured error logging + classification.
 *
 * The returned function:
 *  - On success: returns the raw resolved value of `fn` unchanged.
 *  - On failure: emits a structured JSON line to stderr, attaches a `code`
 *    property on the error if missing, and re-throws so the renderer sees
 *    a rejection.
 *
 * The first IPC argument of an ipcMain.handle callback is an `IpcMainInvokeEvent`;
 * `args_summary` therefore skips it and summarizes the **second** argument
 * (the first user-supplied payload). If only the event is present, no summary
 * is emitted.
 */
export function wrapHandler<Args extends unknown[], Ret>(
  channel: string,
  fn: (...args: Args) => Promise<Ret> | Ret,
): (...args: Args) => Promise<Ret> {
  return async (...args: Args): Promise<Ret> => {
    try {
      const result = await fn(...args);
      return result;
    } catch (err: unknown) {
      const code = classifyError(err);

      // Attach `code` to the error if not already present, so the renderer
      // (T4 useIpc adapter) can branch on it.
      if (err && typeof err === 'object' && !('code' in err)) {
        try {
          (err as { code?: IpcErrorCode }).code = code;
        } catch {
          /* frozen / non-extensible error — ignore */
        }
      }

      // Electron's IPC serializer occasionally drops own properties on
      // Error instances (see https://github.com/electron/electron/issues/24427).
      // The renderer needs the code to branch on — so we ALSO stamp it
      // into the message as a `[CODE] ` prefix. `useIpc` reads the
      // explicit `code` property first and falls back to parsing this
      // prefix when serialization has eaten the property. We only
      // prefix once; a recursive wrap (unusual but possible during
      // handler composition) re-uses the existing prefix.
      if (err instanceof Error) {
        try {
          const msg = err.message ?? '';
          if (!MESSAGE_CODE_PREFIX.test(msg)) {
            err.message = `[${code}] ${msg}`;
          }
        } catch {
          /* frozen message — ignore */
        }
      }

      // Build args summary — skip the IpcMainInvokeEvent (args[0]).
      const userArgs = args.length > 0 ? args.slice(1) : [];
      const summary = buildArgsSummary(userArgs);

      const entry: StructuredLogEntry = {
        ts: Date.now(),
        level: 'error',
        event: 'ipc_error',
        channel,
        error_code: code,
        stack: err instanceof Error ? err.stack : undefined,
        args_summary: summary,
      };
      emit(entry);

      throw err;
    }
  };
}
