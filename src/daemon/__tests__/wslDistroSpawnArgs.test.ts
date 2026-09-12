import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// Exercise the Windows launch path on every CI platform without requiring a
// WSL installation or writing integration files into the runner's home.
class MockPty extends EventEmitter {
  pid = 4242;
  onData() { return { dispose() {} }; }
  onExit() { return { dispose() {} }; }
  write(_data: string): void {}
  resize(_cols: number, _rows: number): void {}
  kill(): void {}
}
const { spawnMock, probeMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  probeMock: vi.fn((args: string[]) => {
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

describe('createSession — WSL distro selection and recovery target', () => {
  let manager: DaemonSessionManager;
  beforeEach(() => {
    spawnMock.mockReset(); probeMock.mockClear();
    spawnMock.mockImplementation(() => new MockPty());
    manager = new DaemonSessionManager();
  });
  afterEach(() => manager.disposeAll());

  it('uses the picker selection to resolve the actual target and persisted args', () => {
    manager.createSession({ id: 'selected', cmd: 'wsl.exe', args: ['-d', 'My Ubuntu'], cwd: '~' });
    expect(probeMock.mock.calls[0][0].slice(0, 2)).toEqual(['-d', 'My Ubuntu']);
    expect(spawnMock.mock.calls[0][1]).toEqual(['--distribution', 'My Ubuntu', '--user', 'developer', '--cd', '/home/developer/project', '--exec', '/bin/bash']);
    expect(manager.getSession('selected')?.meta).toMatchObject({
      args: ['-d', 'My Ubuntu'], wslTarget: { distribution: 'My Ubuntu', user: 'developer' }, cwd: '/home/developer/project',
    });
  });

  it('drops invalid replay args without executing a caller-provided command', () => {
    manager.createSession({ id: 'invalid', cmd: 'wsl.exe', args: ['--exec', 'cmd.exe'], cwd: '~' });
    expect(probeMock.mock.calls[0][0][0]).toBe('--exec');
    expect(spawnMock.mock.calls[0][1]).not.toContain('cmd.exe');
    expect(manager.getSession('invalid')?.meta.args).toEqual(['-d', 'DefaultDistro']);
  });

  it('pins the resolved system default when the picker supplies no distro', () => {
    manager.createSession({ id: 'default', cmd: 'wsl.exe', cwd: '~' });
    expect(manager.getSession('default')?.meta).toMatchObject({
      args: ['-d', 'DefaultDistro'], wslTarget: { distribution: 'DefaultDistro', user: 'developer' },
    });
  });

  it('keeps the saved target and normalizes args when the global choice changes', () => {
    manager.createSession({ id: 'recovery', cmd: 'wsl.exe', cwd: '~', args: ['-d', 'ChangedDefault'],
      wslTarget: { distribution: 'SavedDistro', user: 'saved-user' } });
    expect(probeMock.mock.calls[0][0].slice(0, 4)).toEqual(['--distribution', 'SavedDistro', '--user', 'saved-user']);
    expect(manager.getSession('recovery')?.meta).toMatchObject({
      args: ['-d', 'SavedDistro'], wslTarget: { distribution: 'SavedDistro', user: 'saved-user' },
    });
  });
});
