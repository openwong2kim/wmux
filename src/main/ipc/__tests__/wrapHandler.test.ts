import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildArgsSummary, wrapHandler, type IpcErrorCode } from '../wrapHandler';

describe('wrapHandler', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let writtenLines: string[];

  beforeEach(() => {
    writtenLines = [];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writtenLines.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  function parseLoggedEntry(raw: string): Record<string, unknown> {
    const trimmed = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    return JSON.parse(trimmed) as Record<string, unknown>;
  }

  // 1. 성공 시 raw value 반환
  it('returns the raw value unchanged on success', async () => {
    const wrapped = wrapHandler('test:channel', (_event: unknown, a: number, b: number) => a + b);
    const result = await wrapped({} as never, 2, 3);
    expect(result).toBe(5);
    expect(writtenLines).toHaveLength(0);
  });

  it('preserves resolved promise value on async success', async () => {
    const payload = { id: 'x', shell: 'bash' };
    const wrapped = wrapHandler('pty:create', async (_event: unknown) => payload);
    await expect(wrapped({} as never)).resolves.toBe(payload);
    expect(writtenLines).toHaveLength(0);
  });

  // 2. 에러 throw 시 로그 stderr에 JSON line 출력 + re-throw
  it('writes a structured JSON line to stderr and re-throws on failure', async () => {
    const boom = new Error('something failed');
    const wrapped = wrapHandler('test:fail', (_event: unknown) => {
      throw boom;
    });

    await expect(wrapped({} as never)).rejects.toBe(boom);

    expect(writtenLines).toHaveLength(1);
    const line = writtenLines[0];
    expect(line.endsWith('\n')).toBe(true);
    const entry = parseLoggedEntry(line);
    expect(entry.event).toBe('ipc_error');
    expect(entry.level).toBe('error');
    expect(entry.channel).toBe('test:fail');
    expect(typeof entry.ts).toBe('number');
    expect(entry.stack).toContain('something failed');
  });

  // 3. DAEMON_DISCONNECTED 패턴 감지
  it('classifies "daemon not connected" as DAEMON_DISCONNECTED', async () => {
    const wrapped = wrapHandler('pty:create', (_event: unknown) => {
      throw new Error('daemon not connected');
    });
    await expect(wrapped({} as never)).rejects.toThrow();
    expect(writtenLines).toHaveLength(1);
    const entry = parseLoggedEntry(writtenLines[0]);
    expect(entry.error_code).toBe('DAEMON_DISCONNECTED' satisfies IpcErrorCode);
  });

  it('classifies "Daemon is disconnected" as DAEMON_DISCONNECTED', async () => {
    const wrapped = wrapHandler('pty:create', (_event: unknown) => {
      throw new Error('Daemon is disconnected from pipe');
    });
    await expect(wrapped({} as never)).rejects.toThrow();
    const entry = parseLoggedEntry(writtenLines[0]);
    expect(entry.error_code).toBe('DAEMON_DISCONNECTED' satisfies IpcErrorCode);
  });

  // v2.8.2 — daemon session cap (MAX_SESSIONS) reached.
  // Without this classifier the renderer falls back to a generic
  // "알 수 없는 오류" toast and hides the actionable instruction the
  // daemon attached to the error message.
  it('classifies the daemon session-cap error as RESOURCE_EXHAUSTED', async () => {
    const wrapped = wrapHandler('pty:create', (_event: unknown) => {
      throw new Error(
        'Cannot create new terminal: 200 active sessions already running. ' +
          'Close some panes (or restart wmux) and try again.',
      );
    });
    await expect(wrapped({} as never)).rejects.toThrow();
    const entry = parseLoggedEntry(writtenLines[0]);
    expect(entry.error_code).toBe('RESOURCE_EXHAUSTED' satisfies IpcErrorCode);
  });

  it('stamps the RESOURCE_EXHAUSTED code into the message prefix', async () => {
    const err = new Error(
      'Cannot create new terminal: 200 active sessions already running. ' +
        'Close some panes (or restart wmux) and try again.',
    );
    const wrapped = wrapHandler('pty:create', (_event: unknown) => {
      throw err;
    });
    await expect(wrapped({} as never)).rejects.toBe(err);
    expect((err as unknown as { code?: string }).code).toBe('RESOURCE_EXHAUSTED');
    expect(err.message.startsWith('[RESOURCE_EXHAUSTED] ')).toBe(true);
  });

  it('classifies an unrelated error as UNKNOWN', async () => {
    const wrapped = wrapHandler('test:ch', (_event: unknown) => {
      throw new Error('some random problem');
    });
    await expect(wrapped({} as never)).rejects.toThrow();
    const entry = parseLoggedEntry(writtenLines[0]);
    expect(entry.error_code).toBe('UNKNOWN' satisfies IpcErrorCode);
  });

  // 4. 에러에 code 있으면 보존
  it('preserves a known code property on the error', async () => {
    const err = Object.assign(new Error('no such session'), { code: 'NOT_FOUND' as const });
    const wrapped = wrapHandler('pty:dispose', (_event: unknown) => {
      throw err;
    });
    await expect(wrapped({} as never)).rejects.toBe(err);
    const entry = parseLoggedEntry(writtenLines[0]);
    expect(entry.error_code).toBe('NOT_FOUND' satisfies IpcErrorCode);
    expect((err as { code: string }).code).toBe('NOT_FOUND');
  });

  it('attaches classified code to errors that lack one', async () => {
    const err = new Error('daemon not connected');
    const wrapped = wrapHandler('pty:create', (_event: unknown) => {
      throw err;
    });
    await expect(wrapped({} as never)).rejects.toBe(err);
    expect((err as unknown as { code?: string }).code).toBe('DAEMON_DISCONNECTED');
  });

  it('does not promote an unrecognized error.code to a known code', async () => {
    const err = Object.assign(new Error('weird'), { code: 'ENOENT' });
    const wrapped = wrapHandler('fs:read', (_event: unknown) => {
      throw err;
    });
    await expect(wrapped({} as never)).rejects.toBe(err);
    const entry = parseLoggedEntry(writtenLines[0]);
    // Unknown-string code falls through to UNKNOWN classification.
    expect(entry.error_code).toBe('UNKNOWN' satisfies IpcErrorCode);
    // Existing `code` property is NOT overwritten because it was present.
    expect((err as { code: string }).code).toBe('ENOENT');
  });

  // 5. args_summary 200자 truncate
  it('truncates args_summary beyond 200 characters with ...', () => {
    const longString = 'x'.repeat(500);
    const summary = buildArgsSummary([{ data: longString }]);
    expect(summary).toBeDefined();
    expect(summary!.endsWith('...')).toBe(true);
    // 200 cap + '...' = 203
    expect(summary!.length).toBe(203);
  });

  it('emits truncated args_summary on error', async () => {
    const bigArg = { payload: 'y'.repeat(1000) };
    const wrapped = wrapHandler('test:ch', (_event: unknown, _arg: unknown) => {
      throw new Error('kaboom');
    });
    await expect(wrapped({} as never, bigArg)).rejects.toThrow();
    const entry = parseLoggedEntry(writtenLines[0]);
    const summary = entry.args_summary as string;
    expect(summary.endsWith('...')).toBe(true);
    expect(summary.length).toBe(203);
  });

  it('returns undefined args_summary when no user args are present', async () => {
    const wrapped = wrapHandler('test:ch', (_event: unknown) => {
      throw new Error('oops');
    });
    // Only the ipcMain event is passed — no user payload.
    await expect(wrapped({} as never)).rejects.toThrow();
    const entry = parseLoggedEntry(writtenLines[0]);
    expect(entry.args_summary).toBeUndefined();
  });

  // 6. password 필드 REDACTED
  it('redacts keys matching password/token/secret/key', () => {
    const summary = buildArgsSummary([
      { username: 'alice', password: 'hunter2', authToken: 'abc', secret: 's', apiKey: 'k' },
    ]);
    expect(summary).toBeDefined();
    expect(summary).toContain('[REDACTED]');
    expect(summary).not.toContain('hunter2');
    expect(summary).not.toContain('abc');
    expect(summary).toContain('alice'); // non-sensitive preserved
  });

  it('redacts password field in logged args_summary on error', async () => {
    const wrapped = wrapHandler('auth:login', (_event: unknown, _arg: unknown) => {
      throw new Error('bad creds');
    });
    await expect(
      wrapped({} as never, { user: 'alice', password: 'hunter2' }),
    ).rejects.toThrow();
    const entry = parseLoggedEntry(writtenLines[0]);
    const summary = entry.args_summary as string;
    expect(summary).toContain('[REDACTED]');
    expect(summary).not.toContain('hunter2');
    expect(summary).toContain('alice');
  });

  // 6b. Recursive redaction — nested secrets must not leak (workspace profile
  //     env / startup command flowing through pty:create).
  describe('recursive redaction', () => {
    it('redacts secrets nested inside an object value', () => {
      const summary = buildArgsSummary([
        { workspaceId: 'ws-1', nested: { GITHUB_TOKEN: 'ghp_xxx', safe: 'ok' } },
      ]);
      expect(summary).toBeDefined();
      expect(summary).toContain('[REDACTED]');
      expect(summary).not.toContain('ghp_xxx');
      expect(summary).toContain('ws-1');
      expect(summary).toContain('ok'); // non-sensitive nested value preserved
    });

    it('summarizes an env map to a key count without exposing values', () => {
      const summary = buildArgsSummary([
        { shell: 'powershell.exe', env: { CLAUDE_CONFIG_DIR: 'C:/secret/path', FOO: 'bar' } },
      ]);
      expect(summary).toBeDefined();
      expect(summary).toContain('keyCount');
      expect(summary).toContain('2');
      // Neither env keys nor values appear.
      expect(summary).not.toContain('CLAUDE_CONFIG_DIR');
      expect(summary).not.toContain('C:/secret/path');
      expect(summary).not.toContain('bar');
      expect(summary).toContain('powershell.exe'); // sibling field preserved
    });

    it('redacts a startup/initial command value', () => {
      const summary = buildArgsSummary([
        { workspaceId: 'ws-1', initialCommand: 'claude --token sk-abc123' },
      ]);
      expect(summary).toBeDefined();
      expect(summary).toContain('[REDACTED]');
      expect(summary).not.toContain('sk-abc123');
    });

    it('redacts a non-object value under env (string bypass attempt)', () => {
      // Regression: a malformed env carried as a string must not be stringified
      // into the log. Without the type-agnostic env branch this leaked.
      const summary = buildArgsSummary([
        { shell: 'powershell.exe', env: 'ANTHROPIC_API_KEY=sk-do-not-leak' },
      ]);
      expect(summary).toBeDefined();
      expect(summary).toContain('[REDACTED]');
      expect(summary).not.toContain('sk-do-not-leak');
      expect(summary).not.toContain('ANTHROPIC_API_KEY');
      expect(summary).toContain('powershell.exe');
    });

    it('redacts an array value under env without exposing entries', () => {
      const summary = buildArgsSummary([
        { env: ['SECRET=sk-leak', 'X=1'] },
      ]);
      expect(summary).toBeDefined();
      expect(summary).not.toContain('sk-leak');
    });

    it('never String()-falls-back an object when redaction throws', () => {
      // A throwing getter makes redactDeep/JSON.stringify blow up. The fallback
      // must NOT String() the object (a hostile toString could leak) — it
      // returns a safe marker instead.
      const hostile = {
        get token() { throw new Error('boom'); },
        toString() { return 'SECRET_LEAK_sk-123'; },
      };
      const summary = buildArgsSummary([hostile]);
      expect(summary).toBe('[unserializable]');
      expect(summary).not.toContain('SECRET_LEAK');
    });

    it('redacts secrets inside arrays of objects', () => {
      const summary = buildArgsSummary([
        { items: [{ apiKey: 'k1' }, { name: 'fine' }] },
      ]);
      expect(summary).toBeDefined();
      expect(summary).toContain('[REDACTED]');
      expect(summary).not.toContain('k1');
      expect(summary).toContain('fine');
    });
  });

  // 7. [CODE] message prefix — defensive against Electron IPC property drop
  describe('message code prefix', () => {
    it('stamps `[CODE] ` prefix onto thrown error messages', async () => {
      const err = new Error('daemon not connected');
      const wrapped = wrapHandler('pty:create', (_event: unknown) => {
        throw err;
      });
      await expect(wrapped({} as never)).rejects.toBe(err);
      expect(err.message).toBe('[DAEMON_DISCONNECTED] daemon not connected');
    });

    it('uses the classified code in the prefix when error.code is absent', async () => {
      const err = new Error('something went wrong');
      const wrapped = wrapHandler('test:ch', (_event: unknown) => {
        throw err;
      });
      await expect(wrapped({} as never)).rejects.toBe(err);
      expect(err.message).toBe('[UNKNOWN] something went wrong');
    });

    it('uses the explicit code in the prefix when provided', async () => {
      const err = Object.assign(new Error('no such session'), {
        code: 'NOT_FOUND' as const,
      });
      const wrapped = wrapHandler('pty:dispose', (_event: unknown) => {
        throw err;
      });
      await expect(wrapped({} as never)).rejects.toBe(err);
      expect(err.message).toBe('[NOT_FOUND] no such session');
    });

    it('does not double-prefix a message that already carries one', async () => {
      // Recursive-wrap scenario — a handler that calls another wrapped
      // function can re-enter the catch path. The message must stay
      // stamped exactly once regardless of how many wraps see it.
      const err = new Error('[DAEMON_DISCONNECTED] daemon not connected');
      const wrapped = wrapHandler('pty:create', (_event: unknown) => {
        throw err;
      });
      await expect(wrapped({} as never)).rejects.toBe(err);
      expect(err.message).toBe('[DAEMON_DISCONNECTED] daemon not connected');
    });

    it('leaves non-Error rejection values untouched', async () => {
      const wrapped = wrapHandler('test:ch', (_event: unknown) => {
        // eslint-disable-next-line no-throw-literal
        throw 'string-error';
      });
      await expect(wrapped({} as never)).rejects.toBe('string-error');
      // Nothing to prefix — the thrown value is a primitive.
    });
  });
});
