import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
import { execFile } from 'node:child_process';
import { startNativeCodexRuntime } from '../terminalLaunch';
beforeEach(() => vi.clearAllMocks());
it('coalesces account startup and invokes only the official idempotent start command', async () => {
  let done!: (error: Error | null) => void;
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => { done = args.at(-1) as typeof done; return {} as ReturnType<typeof execFile>; });
  const env = { CODEX_HOME: '/tmp/account', PATH: '/bin' };
  const first = startNativeCodexRuntime(env); const second = startNativeCodexRuntime(env);
  expect(execFile).toHaveBeenCalledTimes(1);
  expect(execFile).toHaveBeenCalledWith('codex', ['app-server', 'daemon', 'start'], expect.objectContaining({ env, timeout: 15000 }), expect.any(Function));
  done(null); await Promise.all([first, second]);
});
it('does not restart or retry a failed runtime startup', async () => {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => { (args.at(-1) as (error: Error) => void)(new Error('failed')); return {} as ReturnType<typeof execFile>; });
  await expect(startNativeCodexRuntime({ CODEX_HOME: '/tmp/failed' })).rejects.toThrow('unavailable');
  expect(execFile).toHaveBeenCalledTimes(1);
});
it('starts the shared runtime with no WMUX_* key at all, instance suffix included', async () => {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => { (args.at(-1) as (error: Error | null) => void)(null); return {} as ReturnType<typeof execFile>; });
  await startNativeCodexRuntime({ CODEX_HOME: '/tmp/identity', WMUX_PTY_ID: 'pty-a', WMUX_WORKSPACE_ID: 'ws-a',
    WMUX_WORKSPACE_NAME: 'A', WMUX_SURFACE_ID: 'sf-a', WMUX_MEMBER_ID: 'pty-a', WMUX_BRAIN_PTY: '1', WMUX_DATA_SUFFIX: '-demo',
    WMUX_SOCKET_PATH: '/tmp/s', WMUX_AUTH_TOKEN: 't', PATH: '/bin' });
  const opts = vi.mocked(execFile).mock.calls[0][2] as { env: NodeJS.ProcessEnv };
  expect(opts.env).toEqual({ CODEX_HOME: '/tmp/identity', PATH: '/bin' });
});
