// A bot worker's secrets reach a WSL worker: each secret NAME is appended to
// that spawn's WSLENV (no path flag, values cross verbatim), in the spawn env
// only. Runs the Windows launch path on every platform (wslDistroSpawnArgs
// harness): no WSL install, no integration files.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

class MockPty extends EventEmitter {
  pid = 4242;
  onData() { return { dispose() { /* no listener */ } }; }
  onExit() { return { dispose() { /* no listener */ } }; }
  write(_data: string): void { /* no PTY input */ }
  resize(_cols: number, _rows: number): void { /* no PTY geometry */ }
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
// The injection's own WSLENV entries, as the real one adds them.
vi.mock('../../shared/wslIntegration', async () => {
  const { wslTargetArgs } = await import('../../shared/wslTarget');
  const { mergeWslEnv } = await import('../../shared/wsl');
  return { buildWslInjection: (opts: { target: Parameters<typeof wslTargetArgs>[0]; cwd: string; env: Record<string, string> }) => ({
    args: [...wslTargetArgs(opts.target), '--cd', opts.cwd, '--exec', '/bin/bash'],
    env: { ...opts.env, WSLENV: mergeWslEnv(opts.env.WSLENV, ['WMUX_PTY_ID', 'WMUX_WSL_BIN/p']) },
  }) };
});
import { DaemonSessionManager, withSecretEnv } from '../DaemonSessionManager';

const VALUE = 'npm_9f8e7d6c5b4a3f2e1d0c';
const spawnEnv = (): Record<string, string> => (spawnMock.mock.calls.at(-1)?.[2] as { env: Record<string, string> }).env;

describe('withSecretEnv', () => {
  it('a WSL spawn: exactly the secret names join WSLENV, the existing entries stay', () => {
    const out = withSecretEnv({ WSLENV: 'USERPROFILE/p:WMUX_PTY_ID' }, { NPM_TOKEN: VALUE, GH_TOKEN: VALUE }, true);
    expect(out.WSLENV).toBe('USERPROFILE/p:WMUX_PTY_ID:NPM_TOKEN:GH_TOKEN');
    expect(out.NPM_TOKEN).toBe(VALUE);
    expect(out.WSLENV).not.toContain(VALUE);
  });

  it('a secret the user already forwards with a flag is forwarded verbatim instead', () => {
    expect(withSecretEnv({ WSLENV: 'NPM_TOKEN/p' }, { NPM_TOKEN: VALUE }, true).WSLENV).toBe('NPM_TOKEN');
  });

  it('a native spawn: WSLENV is not touched', () => {
    expect(withSecretEnv({ PATH: '/usr/bin' }, { NPM_TOKEN: VALUE }, false)).toEqual({ PATH: '/usr/bin', NPM_TOKEN: VALUE });
  });
});

describe('createSessionAsync — a WSL worker with secrets', () => {
  let manager: DaemonSessionManager;
  beforeEach(() => {
    spawnMock.mockReset(); probeMock.mockClear();
    spawnMock.mockImplementation(() => new MockPty());
    manager = new DaemonSessionManager();
  });
  afterEach(() => manager.disposeAll());

  it('is created (no longer refused) and the distro is told the names', async () => {
    await manager.createSessionAsync({
      id: 'wsl-worker', cmd: 'wsl.exe', cwd: '~',
      env: { PATH: 'C:\\Windows', WSLENV: 'USERPROFILE/p' },
      secretEnv: { NPM_TOKEN: VALUE },
    });
    const env = spawnEnv();
    expect(env.NPM_TOKEN).toBe(VALUE);
    expect(env.WSLENV.split(':')).toEqual(['USERPROFILE/p', 'WMUX_PTY_ID', 'WMUX_WSL_BIN/p', 'NPM_TOKEN']);
    // Neither the value nor the name is persisted with the session.
    const meta = manager.getSession('wsl-worker')?.meta;
    expect(JSON.stringify(meta)).not.toContain(VALUE);
    expect(meta?.env?.WSLENV ?? '').not.toContain('NPM_TOKEN');
  });

  it('a WSL spawn without secrets is unchanged', async () => {
    await manager.createSessionAsync({ id: 'wsl-plain', cmd: 'wsl.exe', cwd: '~', env: { PATH: 'C:\\Windows', WSLENV: 'USERPROFILE/p' } });
    expect(spawnEnv().WSLENV).toBe('USERPROFILE/p:WMUX_PTY_ID:WMUX_WSL_BIN/p');
  });
});
