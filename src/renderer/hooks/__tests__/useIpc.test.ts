/**
 * T4 — tests for the `useIpc` adapter.
 *
 * We exercise the pure `createInvoke` factory (same behaviour as what the
 * hook wires up) so the tests can run in vitest's default `node`
 * environment without needing a React renderer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createInvoke, type IpcErrorCode } from '../useIpc';

type ToastSink = (message: string, level: 'info' | 'warn' | 'error') => void;

/** Build a controlled error with an optional `code` attached. */
function makeCodedError(code: string | undefined, message = 'boom'): Error {
  const err = new Error(message);
  if (code !== undefined) {
    (err as Error & { code?: string }).code = code;
  }
  return err;
}

describe('useIpc / createInvoke', () => {
  let toastSpy: ReturnType<typeof vi.fn> & ToastSink;

  beforeEach(() => {
    toastSpy = vi.fn() as ReturnType<typeof vi.fn> & ToastSink;
  });

  describe('success path', () => {
    it('returns { ok: true, data } when the call resolves', async () => {
      const invoke = createInvoke(undefined, toastSpy);
      const result = await invoke(async () => ({ id: 'pty-1' }));
      expect(result).toEqual({ ok: true, data: { id: 'pty-1' } });
      expect(toastSpy).not.toHaveBeenCalled();
    });

    it('passes through raw primitive return values', async () => {
      const invoke = createInvoke(undefined, toastSpy);
      const result = await invoke(async () => 42);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data).toBe(42);
    });
  });

  describe('error classification', () => {
    const cases: Array<{ code: IpcErrorCode; expected: string }> = [
      { code: 'DAEMON_DISCONNECTED', expected: 'daemon이 응답하지 않습니다. 재시도 중…' },
      { code: 'VALIDATION_ERROR',    expected: '요청이 유효하지 않습니다.' },
      { code: 'NOT_FOUND',           expected: '항목을 찾을 수 없습니다.' },
      { code: 'PERMISSION_DENIED',   expected: '권한이 거부되었습니다.' },
      { code: 'RESOURCE_EXHAUSTED',  expected: '터미널 세션 한도에 도달했습니다. 일부 pane을 닫거나 wmux를 재시작한 뒤 다시 시도해주세요.' },
      { code: 'UNKNOWN',             expected: '알 수 없는 오류가 발생했습니다.' },
    ];

    for (const { code, expected } of cases) {
      it(`maps code "${code}" to its default message + emits a toast`, async () => {
        const invoke = createInvoke(undefined, toastSpy);
        const result = await invoke(async () => {
          throw makeCodedError(code);
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(code);
          expect(result.error.message).toBe(expected);
        }
        expect(toastSpy).toHaveBeenCalledTimes(1);
        expect(toastSpy).toHaveBeenCalledWith(expected, expect.any(String));
      });
    }

    it('classifies errors without a `code` property as UNKNOWN', async () => {
      const invoke = createInvoke(undefined, toastSpy);
      const result = await invoke(async () => {
        throw new Error('anything');
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('UNKNOWN');
    });

    it('classifies errors with an unrecognised `code` as UNKNOWN', async () => {
      const invoke = createInvoke(undefined, toastSpy);
      const result = await invoke(async () => {
        throw makeCodedError('BOGUS_CODE');
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('UNKNOWN');
    });

    it('tolerates non-Error rejection values', async () => {
      const invoke = createInvoke(undefined, toastSpy);
      const result = await invoke(async () => {
        // eslint-disable-next-line no-throw-literal
        throw 'string-error';
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('UNKNOWN');
        expect(result.error.original).toBe('string-error');
      }
    });
  });

  describe('options', () => {
    it('silent option suppresses toast for the specified codes', async () => {
      const invoke = createInvoke({ silent: ['NOT_FOUND'] }, toastSpy);
      const result = await invoke(async () => {
        throw makeCodedError('NOT_FOUND');
      });
      expect(result.ok).toBe(false);
      expect(toastSpy).not.toHaveBeenCalled();
    });

    it('silent does not affect unrelated codes', async () => {
      const invoke = createInvoke({ silent: ['NOT_FOUND'] }, toastSpy);
      await invoke(async () => {
        throw makeCodedError('DAEMON_DISCONNECTED');
      });
      expect(toastSpy).toHaveBeenCalledTimes(1);
    });

    it('messages option overrides the default message per code', async () => {
      const invoke = createInvoke(
        { messages: { DAEMON_DISCONNECTED: 'custom daemon down' } },
        toastSpy,
      );
      const result = await invoke(async () => {
        throw makeCodedError('DAEMON_DISCONNECTED');
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toBe('custom daemon down');
      expect(toastSpy).toHaveBeenCalledWith('custom daemon down', expect.any(String));
    });

    it('toastOnError: false suppresses all toasts', async () => {
      const invoke = createInvoke({ toastOnError: false }, toastSpy);
      await invoke(async () => {
        throw makeCodedError('PERMISSION_DENIED');
      });
      expect(toastSpy).not.toHaveBeenCalled();
    });

    it('toast level matches the error severity mapping', async () => {
      const invoke = createInvoke(undefined, toastSpy);
      await invoke(async () => { throw makeCodedError('DAEMON_DISCONNECTED'); });
      await invoke(async () => { throw makeCodedError('PERMISSION_DENIED'); });
      await invoke(async () => { throw makeCodedError('NOT_FOUND'); });

      const calls = toastSpy.mock.calls.map((c) => c[1]);
      expect(calls[0]).toBe('warn'); // DAEMON_DISCONNECTED
      expect(calls[1]).toBe('error'); // PERMISSION_DENIED
      expect(calls[2]).toBe('info'); // NOT_FOUND
    });
  });

  describe('result shape', () => {
    it('error result retains the original thrown value', async () => {
      const invoke = createInvoke(undefined, toastSpy);
      const raw = makeCodedError('VALIDATION_ERROR', 'bad payload');
      const result = await invoke(async () => { throw raw; });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.original).toBe(raw);
    });

    it('never re-throws on failure', async () => {
      const invoke = createInvoke(undefined, toastSpy);
      await expect(
        invoke(async () => { throw makeCodedError('UNKNOWN'); }),
      ).resolves.toBeDefined();
    });
  });

  describe('message prefix fallback', () => {
    // Electron's IPC serializer can drop own `code` property on Error
    // instances. `wrapHandler` also stamps `[CODE] ` into the message,
    // and `useIpc` must fall back to that prefix when the property is
    // gone. These cases exercise that serialization-loss path.

    it('classifies by `[CODE] ` message prefix when err.code is absent', async () => {
      const invoke = createInvoke(undefined, toastSpy);
      const stripped = new Error('[DAEMON_DISCONNECTED] daemon not connected');
      // Deliberately no `code` property — simulates the serializer
      // having dropped it between main and renderer.
      const result = await invoke(async () => { throw stripped; });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('DAEMON_DISCONNECTED');
    });

    it('falls back to UNKNOWN when the prefix is not one of the known codes', async () => {
      const invoke = createInvoke(undefined, toastSpy);
      const stripped = new Error('[BOGUS_CODE] nothing sensible');
      const result = await invoke(async () => { throw stripped; });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('UNKNOWN');
    });

    it('prefers explicit err.code over the message prefix', async () => {
      const invoke = createInvoke(undefined, toastSpy);
      // Both signals present — the explicit code must win so a
      // handler-authored override cannot be subverted by a crafted
      // message body.
      const err = Object.assign(
        new Error('[UNKNOWN] overridden message'),
        { code: 'NOT_FOUND' as const },
      );
      const result = await invoke(async () => { throw err; });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
    });

    // v2.8.2 — codex P2: Electron also wraps the message envelope before
    // it reaches the renderer (`Error invoking remote method '...': Error:
    // <orig>`). If we anchor the prefix regex to `^`, the stamp is hidden
    // behind the envelope and every coded error falls through to UNKNOWN.
    // These cases lock in the un-anchored behaviour.
    it('classifies by `[CODE] ` token even when Electron prepends the invoke envelope', async () => {
      const invoke = createInvoke(undefined, toastSpy);
      const wrapped = new Error(
        `Error invoking remote method 'pty:create': Error: [RESOURCE_EXHAUSTED] Cannot create new terminal: 200 active sessions already running. Close some panes (or restart wmux) and try again.`,
      );
      const result = await invoke(async () => { throw wrapped; });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('RESOURCE_EXHAUSTED');
        expect(result.error.message).toBe(
          '터미널 세션 한도에 도달했습니다. 일부 pane을 닫거나 wmux를 재시작한 뒤 다시 시도해주세요.',
        );
      }
    });

    it('classifies each known code via the message-prefix path', async () => {
      const invoke = createInvoke(undefined, toastSpy);
      const codes: IpcErrorCode[] = [
        'DAEMON_DISCONNECTED',
        'VALIDATION_ERROR',
        'NOT_FOUND',
        'PERMISSION_DENIED',
        'RESOURCE_EXHAUSTED',
        'UNKNOWN',
      ];
      for (const code of codes) {
        const stripped = new Error(`[${code}] stripped payload`);
        const result = await invoke(async () => { throw stripped; });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe(code);
      }
    });
  });
});
