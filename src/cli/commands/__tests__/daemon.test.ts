import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendDaemonStringRequestMock, ensureDaemonMock } = vi.hoisted(() => ({
  sendDaemonStringRequestMock: vi.fn(),
  ensureDaemonMock: vi.fn(),
}));

vi.mock('../../client', () => ({
  sendDaemonStringRequest: sendDaemonStringRequestMock,
  // Real implementation, not a mock: `runStop` needs the actual
  // definitely-absent classification to be exercised, and it is pure (reads
  // only `err.code`) so re-declaring it here carries no risk of drifting
  // from `client.ts` in a way a test would fail to catch — any behavior
  // change there is a one-line diff to mirror. Deliberately narrower than
  // `isConnectFailure` (no EPERM) — see that function's doc comment.
  isDefinitelyNotRunning: (err: unknown) => {
    const code = (err as { code?: string })?.code;
    return code === 'ENOENT' || code === 'ECONNREFUSED';
  },
}));

vi.mock('../../../shared/daemon/daemonLauncherCore', () => ({
  ensureDaemon: ensureDaemonMock,
}));

import { handleDaemon } from '../daemon';

let logLines: string[];
let errorLines: string[];

beforeEach(() => {
  logLines = [];
  errorLines = [];
  sendDaemonStringRequestMock.mockReset();
  ensureDaemonMock.mockReset();
  process.exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logLines.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errorLines.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('wmux daemon status', () => {
  it('reports running with the ping payload', async () => {
    sendDaemonStringRequestMock.mockResolvedValue({
      id: 'x', ok: true, result: { status: 'ok', pid: 4242, sessions: 2 },
    });

    await handleDaemon('status', [], false);

    expect(sendDaemonStringRequestMock).toHaveBeenCalledWith('daemon.ping', {});
    const output = logLines.join('\n');
    expect(output).toContain('wmux daemon is running.');
    expect(output).toContain('pid: 4242');
  });

  it('reports not running when the pipe is unreachable, without throwing, and exits non-zero', async () => {
    sendDaemonStringRequestMock.mockRejectedValue(new Error('connect ENOENT'));

    await handleDaemon('status', [], false);

    expect(logLines.join('\n')).toContain('wmux daemon is not running.');
    // #1019 CodeRabbit finding: a transport failure IS "not running" for a
    // human, but a script needs the exit code to tell it apart from a
    // clean, healthy status check.
    expect(process.exitCode).toBe(1);
  });

  it('--json mode passes the raw RPC envelope through on failure too', async () => {
    sendDaemonStringRequestMock.mockRejectedValue(new Error('connect ENOENT'));

    await handleDaemon('status', [], true);

    const parsed = JSON.parse(logLines.join('\n'));
    expect(parsed).toMatchObject({ ok: false, running: false });
  });

  it('#1019 review: --json success also carries running:true, matching the failure shape', async () => {
    // Before the fix, a healthy `daemon.ping` result had no `running` field
    // at all (it never needed to say "running" — a successful ping IS
    // running) while the failure shape was `{ok, running: false, error}`. A
    // script keying on `.running` read `undefined` for an up daemon.
    sendDaemonStringRequestMock.mockResolvedValue({
      id: 'x', ok: true, result: { status: 'ok', pid: 4242, sessions: 2 },
    });

    await handleDaemon('status', [], true);

    const parsed = JSON.parse(logLines.join('\n'));
    expect(parsed).toMatchObject({ ok: true, running: true, pid: 4242, sessions: 2 });
  });
});

describe('wmux daemon stop', () => {
  it('confirms shutdown via daemon.shutdown', async () => {
    sendDaemonStringRequestMock.mockResolvedValue({ id: 'x', ok: true, result: { status: 'ok' } });

    await handleDaemon('stop', [], false);

    expect(sendDaemonStringRequestMock).toHaveBeenCalledWith('daemon.shutdown', {});
    expect(logLines.join('\n')).toContain('wmux daemon stopped.');
  });

  it('reports not running rather than throwing when already down (connect failure)', async () => {
    sendDaemonStringRequestMock.mockRejectedValue(Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' }));

    await handleDaemon('stop', [], false);

    expect(logLines.join('\n')).toContain('wmux daemon is not running.');
    expect(process.exitCode).toBeUndefined();
  });

  it('#1019 review: does NOT report success on a non-connect failure (timeout/permission/etc)', async () => {
    // Before the fix, runStop treated every rejection — including a request
    // timeout or a permission error, neither of which mean "already
    // stopped" — as "wmux daemon is not running.", exit 0. A caller doing
    // `wmux daemon stop && rm -rf $DATA_DIR` would proceed against a daemon
    // that never actually shut down.
    sendDaemonStringRequestMock.mockRejectedValue(new Error('Request timed out after 5 seconds.'));

    await handleDaemon('stop', [], false);

    expect(logLines.join('\n')).not.toContain('wmux daemon is not running.');
    expect(errorLines.join('\n')).toContain('wmux daemon stop:');
    expect(process.exitCode).toBe(1);
  });

  it('#1019 second review: EPERM is NOT treated as "already stopped" (a permission error is not proof of absence)', async () => {
    // EPERM is a member of isConnectFailure's set (it triggers the pipe->TCP
    // retry inside sendRequest), but it does NOT mean "no daemon listening" —
    // it can mean a daemon owned by another user/session IS listening and
    // refused the connection. Before this fix runStop conflated the two
    // predicates and reported a clean "not running" here.
    sendDaemonStringRequestMock.mockRejectedValue(Object.assign(new Error('EPERM, connect'), { code: 'EPERM' }));

    await handleDaemon('stop', [], false);

    expect(logLines.join('\n')).not.toContain('wmux daemon is not running.');
    expect(errorLines.join('\n')).toContain('wmux daemon stop:');
    expect(process.exitCode).toBe(1);
  });

  it('#1019 review: a non-connect failure in --json mode reports ok:false, not ok:true', async () => {
    sendDaemonStringRequestMock.mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }));

    await handleDaemon('stop', [], true);

    const parsed = JSON.parse(logLines.join('\n'));
    expect(parsed).toMatchObject({ ok: false });
    expect(process.exitCode).toBe(1);
  });
});

describe('wmux daemon start', () => {
  it('reports the spawned pid and pipe on a fresh start', async () => {
    ensureDaemonMock.mockResolvedValue({
      pid: 555, authToken: 'super-secret-token', pipeName: '\\.\pipe\wmux-daemon-x', spawned: true,
    });

    await handleDaemon('start', [], false);

    const output = logLines.join('\n');
    expect(output).toContain('wmux daemon started (PID 555)');
    expect(output).not.toContain('super-secret-token');
  });

  it('reports reuse when a daemon already answers', async () => {
    ensureDaemonMock.mockResolvedValue({
      pid: 555, authToken: 'x', pipeName: '\\.\pipe\wmux-daemon-x', spawned: false,
    });

    await handleDaemon('start', [], false);

    expect(logLines.join('\n')).toContain('wmux daemon already running (PID 555)');
  });

  it('never echoes the auth token in --json output', async () => {
    ensureDaemonMock.mockResolvedValue({
      pid: 555, authToken: 'super-secret-token', pipeName: '\\.\pipe\wmux-daemon-x', spawned: true,
    });

    await handleDaemon('start', [], true);

    const output = logLines.join('\n');
    expect(output).not.toContain('super-secret-token');
    const parsed = JSON.parse(output);
    expect(parsed).toEqual({ ok: true, pid: 555, pipeName: '\\.\pipe\wmux-daemon-x', spawned: true });
  });

  it('surfaces a spawn failure without throwing out of the CLI, and sets exit code 1', async () => {
    ensureDaemonMock.mockRejectedValue(new Error('Daemon script not found in: a, b'));

    await handleDaemon('start', [], false);

    expect(errorLines.join('\n')).toContain('Daemon script not found');
    expect(process.exitCode).toBe(1);
  });
});

describe('wmux daemon <unknown>', () => {
  it('prints usage and sets exit code 1', async () => {
    await handleDaemon('bogus', [], false);

    expect(errorLines.join('\n')).toContain('Usage: wmux daemon start | stop | status');
    expect(process.exitCode).toBe(1);
  });
});
