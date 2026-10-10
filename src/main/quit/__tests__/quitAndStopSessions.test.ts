import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { quitMock, showMessageBoxMock, killMock, raceMock } = vi.hoisted(() => ({
  quitMock: vi.fn(),
  showMessageBoxMock: vi.fn<(...args: unknown[]) => Promise<{ response: number }>>(async () => ({ response: 1 })),
  killMock: vi.fn((): string => 'dead'),
  raceMock: vi.fn<(...args: unknown[]) => Promise<{ ok: boolean; error?: string }>>(async () => ({ ok: true })),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), getLocale: vi.fn(() => 'en-US'), quit: quitMock },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null) },
  dialog: { showMessageBox: showMessageBoxMock, showErrorBox: vi.fn() },
}));
vi.mock('../../daemon/launcher', () => ({ killDaemonByPidFile: killMock }));
vi.mock('../../daemonShutdownRace', () => ({ raceDaemonShutdown: raceMock }));

import { LOCALE_OPTIONS } from '../../../renderer/i18n';
import type { DaemonClient } from '../../DaemonClient';
import { buildQuitAndStopCopy, buildQuitAndStopNotice, readUiLocale, type QuitAndStopCopy } from '../quitAndStopCopy';
import {
  __resetQuitAndStopForTest,
  countLiveSessions,
  quitAndStopSessions,
  runQuitAndStopSessions,
  stopDaemon,
  type QuitAndStopDeps,
} from '../quitAndStopSessions';

const COPY: QuitAndStopCopy = { message: 'm', detail: 'd', confirm: 'c', cancel: 'x' };

function deps(over: Partial<QuitAndStopDeps> = {}): QuitAndStopDeps & { order: string[] } {
  const order: string[] = [];
  return {
    order,
    countSessions: vi.fn(async () => ({ sessions: 3, agents: 2 })),
    buildCopy: vi.fn(async () => COPY),
    confirm: vi.fn(async () => true),
    isQuitting: vi.fn(() => false),
    stopDaemon: vi.fn(async () => { order.push('stop'); return true; }),
    showNotice: vi.fn(async (kind) => { order.push(`notice:${kind}`); }),
    onShutdownAll: vi.fn(() => { order.push('shutdownAll'); }),
    quit: vi.fn(() => { order.push('quit'); }),
    ...over,
  };
}

describe('runQuitAndStopSessions', () => {
  it('on confirm, stops the daemon, then flips the flag, then quits', async () => {
    const d = deps();
    await expect(runQuitAndStopSessions(d)).resolves.toBe('quit');
    expect(d.buildCopy).toHaveBeenCalledWith({ sessions: 3, agents: 2 });
    expect(d.order).toEqual(['stop', 'shutdownAll', 'quit']);
  });

  it('on cancel, neither stops, flips the flag nor quits', async () => {
    const d = deps({ confirm: vi.fn(async () => false) });
    await expect(runQuitAndStopSessions(d)).resolves.toBe('cancelled');
    expect(d.order).toEqual([]);
  });

  it('a failed stop shows the recovery error and keeps the app open', async () => {
    const d = deps({ stopDaemon: vi.fn(async () => false) });
    await expect(runQuitAndStopSessions(d)).resolves.toBe('failed');
    expect(d.order).toEqual(['notice:stopFailed']);
  });

  it('refuses when a plain Quit is already running, before or after the dialog', async () => {
    const before = deps({ isQuitting: vi.fn(() => true) });
    await expect(runQuitAndStopSessions(before)).resolves.toBe('refused');
    expect(before.confirm).not.toHaveBeenCalled();
    expect(before.order).toEqual(['notice:alreadyQuitting']);

    const quitting = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const after = deps({ isQuitting: quitting });
    await expect(runQuitAndStopSessions(after)).resolves.toBe('refused');
    expect(after.order).toEqual(['notice:alreadyQuitting']);
  });

  it('still asks when the count is unavailable, and passes null rather than 0', async () => {
    const d = deps({ countSessions: vi.fn(async () => null) });
    await runQuitAndStopSessions(d);
    expect(d.buildCopy).toHaveBeenCalledWith(null);
    expect(d.confirm).toHaveBeenCalled();
  });
});

describe('stopDaemon', () => {
  const connected = { isConnected: true } as unknown as DaemonClient;
  beforeEach(() => vi.clearAllMocks());

  it('is done once daemon.shutdown acks, without the pid kill', async () => {
    raceMock.mockResolvedValueOnce({ ok: true });
    await expect(stopDaemon(connected)).resolves.toBe(true);
    expect(killMock).not.toHaveBeenCalled();
  });

  it.each([
    ['killed', true],
    ['dead', true],
    ['unverifiable', false],
    ['failed', false],
    ['not-daemon', false],
  ])('falls back to the pid kill on a timeout: %s → %s', async (outcome, stopped) => {
    raceMock.mockResolvedValueOnce({ ok: false, error: 'timeout' });
    killMock.mockReturnValueOnce(outcome);
    await expect(stopDaemon(connected)).resolves.toBe(stopped);
  });

  it('without a connected client goes straight to the pid kill', async () => {
    killMock.mockReturnValueOnce('dead');
    await expect(stopDaemon(null)).resolves.toBe(true);
    expect(raceMock).not.toHaveBeenCalled();
  });
});

describe('quitAndStopSessions (the click handler)', () => {
  const callbacks = () => ({
    onShutdownAll: vi.fn(),
    getDaemonClient: vi.fn(() => ({ isConnected: true, rpc: vi.fn(async () => []) }) as unknown as DaemonClient),
    isQuitting: vi.fn(() => false),
    prepareStop: vi.fn(),
  });
  beforeEach(() => {
    vi.clearAllMocks();
    __resetQuitAndStopForTest();
  });

  it('stops the respawn loop before the daemon, and stays latched after a confirmed quit', async () => {
    const cb = callbacks();
    const order: string[] = [];
    cb.prepareStop.mockImplementation(() => order.push('prepare'));
    raceMock.mockImplementationOnce(async () => { order.push('shutdown'); return { ok: true }; });
    await quitAndStopSessions(cb);
    expect(order).toEqual(['prepare', 'shutdown']);
    expect(quitMock).toHaveBeenCalledOnce();

    // A second selection must not reach app.quit() past the first one's stop.
    await quitAndStopSessions(cb);
    expect(showMessageBoxMock).toHaveBeenCalledOnce();
    expect(quitMock).toHaveBeenCalledOnce();
  });

  it('ignores a click while the first stop is still running', async () => {
    const cb = callbacks();
    let release!: (v: { ok: boolean }) => void;
    raceMock.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const first = quitAndStopSessions(cb);
    await vi.waitFor(() => expect(raceMock).toHaveBeenCalled());
    await quitAndStopSessions(cb);
    expect(showMessageBoxMock).toHaveBeenCalledOnce();
    release({ ok: true });
    await first;
    expect(quitMock).toHaveBeenCalledOnce();
  });

  it('releases the latch after a cancel or a failed stop', async () => {
    const cb = callbacks();
    showMessageBoxMock.mockResolvedValueOnce({ response: 0 });
    await quitAndStopSessions(cb);
    raceMock.mockResolvedValueOnce({ ok: false, error: 'timeout' });
    killMock.mockReturnValueOnce('unverifiable');
    await quitAndStopSessions(cb);
    expect(quitMock).not.toHaveBeenCalled();
    // confirm (cancelled), confirm (confirmed), stop-failed error.
    expect(showMessageBoxMock).toHaveBeenCalledTimes(3);
    expect(showMessageBoxMock.mock.calls[2][0]).toMatchObject({ type: 'error' });
    expect(cb.onShutdownAll).not.toHaveBeenCalled();
  });
});

describe('countLiveSessions', () => {
  const client = (rows: unknown, connected = true): DaemonClient =>
    ({ isConnected: connected, rpc: vi.fn(async () => rows) }) as unknown as DaemonClient;

  it('counts attached/detached sessions and the ones running an agent or an exec unit', async () => {
    // Trimmed daemon.listSessions rows: `liveAgent` is the tracked slug, set
    // only while the agent process lives; exec units carry `exec`.
    const rows = [
      { id: 'a', state: 'attached', shell: '/bin/zsh', commandRunning: true, liveAgent: 'claude' },
      { id: 'b', state: 'detached', shell: '/bin/zsh', liveAgent: 'codex' },
      { id: 'c', state: 'attached', shell: '/bin/zsh', commandRunning: false },
      { id: 'd', state: 'detached', shell: '/bin/zsh', exec: { command: 'claude -p hi' } },
      { id: 'e', state: 'dead', shell: '/bin/zsh', liveAgent: 'claude' },
      { id: 'f', state: 'suspended', shell: '/bin/zsh', exec: { command: 'codex' } },
    ];
    await expect(countLiveSessions(client(rows))).resolves.toEqual({ sessions: 4, agents: 3 });
  });

  it('is null without a connected client or when the RPC fails', async () => {
    await expect(countLiveSessions(null)).resolves.toBeNull();
    await expect(countLiveSessions(client([], false))).resolves.toBeNull();
    const failing = { isConnected: true, rpc: vi.fn(async () => { throw new Error('timeout'); }) } as unknown as DaemonClient;
    await expect(countLiveSessions(failing)).resolves.toBeNull();
  });
});

describe('buildQuitAndStopCopy', () => {
  it('names both counts in English', async () => {
    const copy = await buildQuitAndStopCopy('en', { sessions: 5, agents: 2 });
    expect(copy.detail).toContain('Agent sessions running: 2');
    expect(copy.detail).toContain('Terminals in all: 5');
    expect(copy.confirm).toBe('Quit and Stop Sessions');
    expect(copy.cancel).toBe('Cancel');
  });

  it('never states a number when the count is unknown', async () => {
    const copy = await buildQuitAndStopCopy('en', null);
    expect(copy.detail).not.toMatch(/\d/);
  });

  it.each(LOCALE_OPTIONS.map((o) => o.value))('%s: loads its own table and fills both counts', async (locale) => {
    const en = await buildQuitAndStopCopy('en', { sessions: 7, agents: 4 });
    const copy = await buildQuitAndStopCopy(locale, { sessions: 7, agents: 4 });
    expect(copy.detail).toContain('7');
    expect(copy.detail).toContain('4');
    expect(copy.detail).not.toMatch(/\{\w+\}/);
    for (const kind of ['stopFailed', 'alreadyQuitting'] as const) {
      expect((await buildQuitAndStopNotice(locale, kind)).detail).toContain('wmux daemon stop');
    }
    if (locale !== 'en') {
      expect(copy.message).not.toBe(en.message);
      expect(copy.cancel).not.toBe(en.cancel);
      expect((await buildQuitAndStopNotice(locale, 'stopFailed')).message)
        .not.toBe((await buildQuitAndStopNotice('en', 'stopFailed')).message);
    }
  });
});

describe('readUiLocale', () => {
  const dirWith = (body: string | null): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quit-locale-'));
    if (body !== null) fs.writeFileSync(path.join(dir, 'session.json'), body);
    return dir;
  };

  it('prefers the locale the renderer persisted', () => {
    expect(readUiLocale(dirWith(JSON.stringify({ locale: 'pt-BR' })), 'en-US')).toBe('pt-BR');
  });

  it('falls back to the OS locale, then its base language, then English', () => {
    expect(readUiLocale(dirWith(null), 'zh-TW')).toBe('zh-TW');
    expect(readUiLocale(dirWith('{not json'), 'de-AT')).toBe('de');
    expect(readUiLocale(dirWith(JSON.stringify({ locale: 'xx' })), 'xx-YY')).toBe('en');
  });
});
