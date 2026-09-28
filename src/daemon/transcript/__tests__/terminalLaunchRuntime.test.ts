import { beforeEach, expect, it, vi } from 'vitest';
// The start goes through runCli (#1619), which picks execFile or cross-spawn by
// platform. Mocking at that boundary keeps these assertions identical on every
// CI platform; runCli's own spawn behaviour is covered in shared/__tests__.
vi.mock('../../../shared/runCli', () => ({ runCli: vi.fn() }));
import { runCli } from '../../../shared/runCli';
import { startNativeCodexRuntime } from '../terminalLaunch';
beforeEach(() => vi.clearAllMocks());
it('coalesces account startup and invokes only the official idempotent start command', async () => {
  let done!: (value: string) => void;
  vi.mocked(runCli).mockImplementation(() => new Promise<string>((resolve) => { done = resolve; }));
  const env = { CODEX_HOME: '/tmp/account', PATH: '/bin' };
  const first = startNativeCodexRuntime(env); const second = startNativeCodexRuntime(env);
  expect(runCli).toHaveBeenCalledTimes(1);
  expect(runCli).toHaveBeenCalledWith('codex', ['app-server', 'daemon', 'start'], expect.objectContaining({ env, timeoutMs: 15000 }));
  done(''); await Promise.all([first, second]);
});
it('does not restart or retry a failed runtime startup', async () => {
  vi.mocked(runCli).mockRejectedValue(new Error('failed'));
  await expect(startNativeCodexRuntime({ CODEX_HOME: '/tmp/failed' })).rejects.toThrow('unavailable');
  expect(runCli).toHaveBeenCalledTimes(1);
});
it('starts the shared runtime with no WMUX_* key at all, instance suffix included', async () => {
  vi.mocked(runCli).mockResolvedValue('');
  await startNativeCodexRuntime({ CODEX_HOME: '/tmp/identity', WMUX_PTY_ID: 'pty-a', WMUX_WORKSPACE_ID: 'ws-a',
    WMUX_WORKSPACE_NAME: 'A', WMUX_SURFACE_ID: 'sf-a', WMUX_MEMBER_ID: 'pty-a', WMUX_BRAIN_PTY: '1', WMUX_DATA_SUFFIX: '-demo',
    WMUX_SOCKET_PATH: '/tmp/s', WMUX_AUTH_TOKEN: 't', PATH: '/bin' });
  const opts = vi.mocked(runCli).mock.calls[0][2] as { env: NodeJS.ProcessEnv };
  expect(opts.env).toEqual({ CODEX_HOME: '/tmp/identity', PATH: '/bin' });
});
