// #2771 — the shell-mark hint a session's bridge gets: a WSL shell runs wmux's
// integration unless the pane opts out with WMUX_SHELL_INTEGRATION=0, and then
// its output passes through unread ('plain'). Runs the Windows launch path on
// every platform (as DaemonSessionManager.wslSecretEnv.os.test.ts): no WSL
// install, no integration files.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

class MockPty extends EventEmitter {
  pid = 4243;
  onData() { return { dispose() { /* no listener */ } }; }
  onExit() { return { dispose() { /* no listener */ } }; }
  write(): void { /* no PTY input */ }
  resize(): void { /* no PTY geometry */ }
  kill(): void { /* no child */ }
}
const { spawnMock, probeMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  probeMock: vi.fn((): string => 'Ubuntu\0developer\0/home/developer/project\0'),
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
// The injection passes the pane's env through, as the real one does.
vi.mock('../../shared/wslIntegration', async () => {
  const { wslTargetArgs } = await import('../../shared/wslTarget');
  return { buildWslInjection: (opts: { target: Parameters<typeof wslTargetArgs>[0]; cwd: string; env: Record<string, string> }) => ({
    args: [...wslTargetArgs(opts.target), '--cd', opts.cwd, '--exec', '/bin/bash'],
    env: { ...opts.env },
  }) };
});
import { DaemonSessionManager } from '../DaemonSessionManager';
import { DaemonPTYBridge } from '../DaemonPTYBridge';

describe('createSessionAsync — the shell-mark hint (#2771)', () => {
  let manager: DaemonSessionManager;
  let forwarding: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spawnMock.mockReset(); probeMock.mockClear();
    spawnMock.mockImplementation(() => new MockPty());
    forwarding = vi.spyOn(DaemonPTYBridge.prototype, 'setupDataForwarding');
    manager = new DaemonSessionManager();
  });
  afterEach(() => {
    manager.disposeAll();
    forwarding.mockRestore();
  });
  const hint = () => forwarding.mock.calls.at(-1)?.[4];

  it('a WSL shell runs wmux\'s integration: its marks are scanned', async () => {
    await manager.createSessionAsync({ id: 'wsl-marks', cmd: 'wsl.exe', cwd: '~', env: { PATH: 'C:\\Windows' } });
    expect(hint()).toBe('integrated');
  });

  it('a WSL shell with WMUX_SHELL_INTEGRATION=0 writes no marks of its own: its output passes through', async () => {
    await manager.createSessionAsync({ id: 'wsl-optout', cmd: 'wsl.exe', cwd: '~', env: { PATH: 'C:\\Windows', WMUX_SHELL_INTEGRATION: '0' } });
    expect(hint()).toBe('plain');
  });
});
