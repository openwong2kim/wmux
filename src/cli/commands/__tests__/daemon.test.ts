import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendDaemonStringRequestMock, ensureDaemonMock } = vi.hoisted(() => ({
  sendDaemonStringRequestMock: vi.fn(),
  ensureDaemonMock: vi.fn(),
}));

vi.mock('../../client', () => ({
  sendDaemonStringRequest: sendDaemonStringRequestMock,
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

  it('reports not running when the pipe is unreachable, without throwing', async () => {
    sendDaemonStringRequestMock.mockRejectedValue(new Error('connect ENOENT'));

    await handleDaemon('status', [], false);

    expect(logLines.join('\n')).toContain('wmux daemon is not running.');
    expect(process.exitCode).toBeUndefined();
  });

  it('--json mode passes the raw RPC envelope through on failure too', async () => {
    sendDaemonStringRequestMock.mockRejectedValue(new Error('connect ENOENT'));

    await handleDaemon('status', [], true);

    const parsed = JSON.parse(logLines.join('\n'));
    expect(parsed).toMatchObject({ ok: false, running: false });
  });
});

describe('wmux daemon stop', () => {
  it('confirms shutdown via daemon.shutdown', async () => {
    sendDaemonStringRequestMock.mockResolvedValue({ id: 'x', ok: true, result: { status: 'ok' } });

    await handleDaemon('stop', [], false);

    expect(sendDaemonStringRequestMock).toHaveBeenCalledWith('daemon.shutdown', {});
    expect(logLines.join('\n')).toContain('wmux daemon stopped.');
  });

  it('reports not running rather than throwing when already down', async () => {
    sendDaemonStringRequestMock.mockRejectedValue(new Error('connect ENOENT'));

    await handleDaemon('stop', [], false);

    expect(logLines.join('\n')).toContain('wmux daemon is not running.');
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
