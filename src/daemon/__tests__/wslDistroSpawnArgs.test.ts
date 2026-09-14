import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Exercise the Windows launch path on every CI platform without requiring a
// WSL installation or writing integration files into the runner's home.
class MockPty extends EventEmitter {
  pid = 4242;
  onData() { return { dispose() { /* No listener is registered by this mock. */ } }; }
  onExit() { return { dispose() { /* No listener is registered by this mock. */ } }; }
  write(_data: string): void { /* No real PTY input. */ }
  resize(_cols: number, _rows: number): void { /* No real PTY geometry. */ }
  kill(): void { /* No child process to terminate. */ }
}
const { spawnMock, probeMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  probeMock: vi.fn((args: string[]): string | Promise<string> => {
    const distro = ['-d', '--distribution'].includes(args[0]) ? args[1] : 'DefaultDistro';
    const user = args.includes('--user') ? args[args.indexOf('--user') + 1] : 'developer';
    return `${distro}\0${user}\0/home/${user}/project\0`;
  }),
}));
vi.mock('node-pty', () => ({ default: { spawn: spawnMock }, spawn: spawnMock }));
vi.mock('../../shared/wsl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/wsl')>();
  return {
    ...actual,
    isWslShell: (shell: string) => actual.isWslShell(shell, 'win32'),
    resolveWslCwd: (shell: string, cwd: string, target: Parameters<typeof actual.resolveWslCwd>[2], _probe: unknown, args: string[]) =>
      actual.resolveWslCwd(shell, cwd, target, probeMock, args),
  };
});
vi.mock('../../shared/wslIntegration', async () => {
  const { wslTargetArgs } = await import('../../shared/wslTarget');
  return { buildWslInjection: (opts: { target: Parameters<typeof wslTargetArgs>[0]; cwd: string; env: Record<string, string> }) => ({
    args: [...wslTargetArgs(opts.target), '--cd', opts.cwd, '--exec', '/bin/bash'], env: opts.env,
  }) };
});
import { DaemonSessionManager } from '../DaemonSessionManager';
import { StateWriter } from '../StateWriter';

describe('createSession — WSL distro selection and recovery target', () => {
  let manager: DaemonSessionManager;
  beforeEach(() => {
    spawnMock.mockReset(); probeMock.mockClear();
    spawnMock.mockImplementation(() => new MockPty());
    manager = new DaemonSessionManager();
  });
  afterEach(() => manager.disposeAll());

  it('uses the picker selection to resolve the actual target and persisted args', async () => {
    await manager.createSessionAsync({ id: 'selected', cmd: 'wsl.exe', args: ['-d', 'My Ubuntu'], cwd: '~' });
    expect(probeMock.mock.calls[0][0].slice(0, 2)).toEqual(['-d', 'My Ubuntu']);
    expect(spawnMock.mock.calls[0][1]).toEqual(['--distribution', 'My Ubuntu', '--user', 'developer', '--cd', '/home/developer/project', '--exec', '/bin/bash']);
    expect(manager.getSession('selected')?.meta).toMatchObject({
      args: ['-d', 'My Ubuntu'], wslTarget: { distribution: 'My Ubuntu', user: 'developer' }, cwd: '/home/developer/project',
    });
  });

  it('drops invalid replay args without executing a caller-provided command', async () => {
    await manager.createSessionAsync({ id: 'invalid', cmd: 'wsl.exe', args: ['--exec', 'cmd.exe'], cwd: '~' });
    expect(probeMock.mock.calls[0][0][0]).toBe('--exec');
    expect(spawnMock.mock.calls[0][1]).not.toContain('cmd.exe');
    expect(manager.getSession('invalid')?.meta.args).toEqual(['-d', 'DefaultDistro']);
  });

  it('pins the resolved system default when the picker supplies no distro', async () => {
    await manager.createSessionAsync({ id: 'default', cmd: 'wsl.exe', cwd: '~' });
    expect(manager.getSession('default')?.meta).toMatchObject({
      args: ['-d', 'DefaultDistro'], wslTarget: { distribution: 'DefaultDistro', user: 'developer' },
    });
  });

  it('keeps the saved target and normalizes args when the global choice changes', async () => {
    await manager.createSessionAsync({ id: 'recovery', cmd: 'wsl.exe', cwd: '~', args: ['-d', 'ChangedDefault'],
      wslTarget: { distribution: 'SavedDistro', user: 'saved-user' } });
    expect(probeMock.mock.calls[0][0].slice(0, 4)).toEqual(['--distribution', 'SavedDistro', '--user', 'saved-user']);
    expect(manager.getSession('recovery')?.meta).toMatchObject({
      args: ['-d', 'SavedDistro'], wslTarget: { distribution: 'SavedDistro', user: 'saved-user' },
    });
  });
  it('cancels an in-flight WSL creation on close and keeps other session operations responsive', async () => {
    let resolve!: (value: string) => void;
    probeMock.mockImplementationOnce(() => new Promise<string>((r) => { resolve = r; }));
    const pending = manager.createSessionAsync({ id: 'slow', cmd: 'wsl.exe', cwd: '~' });
    manager.createSession({ id: 'native', cmd: '/bin/bash' });
    expect(manager.listLiveSessions().map((s) => s.id)).toEqual(['native']);
    manager.destroySession('slow');
    resolve('Ubuntu\0developer\0/home/developer\0');
    await expect(pending).rejects.toThrow('cancelled');
    expect(manager.getSession('slow')).toBeUndefined();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('retains failed recovery metadata without counting it as a live PTY, and removes it on explicit close', async () => {
    const meta = await manager.createSessionAsync({ id: 'saved', cmd: 'wsl.exe', cwd: '~' });
    manager.destroySession('saved');
    manager.keepPendingRecovery({ ...meta, bufferDumpPath: '/saved/buffer' }, 'Distro unavailable');
    expect(manager.listLiveSessions()).toHaveLength(0);
    expect(manager.listSessions()).toMatchObject([{ id: 'saved', state: 'suspended', bufferDumpPath: '/saved/buffer', recoveryError: 'Distro unavailable' }]);
    manager.destroySession('saved');
    expect(manager.listSessions()).toHaveLength(0);
  });

  it('expires unattempted recovery after the suspended TTL but retains genuine failures across saves', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pending-expiry-'));
    const writer = new StateWriter(tmpDir, 24);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const meta = await manager.createSessionAsync({ id: 'saved', cmd: 'wsl.exe', cwd: '~' });
      manager.destroySession(meta.id);
      for (const [id, recoveryError] of [
        ['unattempted', undefined],
        ['legacy-placeholder', 'WSL session is waiting to reconnect.'],
        ['failed', 'WSL distro unavailable'],
      ] as const) {
        manager.keepPendingRecovery({ ...meta, id, env: {}, recoveryError,
          lastActivity: new Date(now).toISOString(), bufferDumpPath: path.join(tmpDir, `${id}.buf`),
        }, recoveryError);
      }
      expect(manager.getPendingRecovery('unattempted')).not.toHaveProperty('recoveryError');
      expect(manager.listLiveSessions()).toHaveLength(0);
      writer.saveImmediate({ version: 1, sessions: manager.listSessions() });
      expect(writer.load().sessions.map(s => s.id)).toEqual(['unattempted', 'legacy-placeholder', 'failed']);

      // A subsequent boot preserves the distinction and the original activity
      // time. Merely saving a placeholder must not renew its retention period.
      for (const session of writer.load().sessions) {
        manager.keepPendingRecovery(session, session.recoveryError);
      }
      writer.saveImmediate({ version: 1, sessions: manager.listSessions() });
      clock.mockReturnValue(now + 25 * 60 * 60 * 1000);
      expect(writer.load().sessions).toMatchObject([{
        id: 'failed', state: 'suspended', recoveryError: 'WSL distro unavailable',
        bufferDumpPath: path.join(tmpDir, 'failed.buf'),
      }]);
    } finally {
      clock.mockRestore();
      writer.dispose();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});
