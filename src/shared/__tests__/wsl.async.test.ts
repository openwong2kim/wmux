import { describe, it, expect, vi, beforeEach } from 'vitest';
const { exec } = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: exec }));
import { resolveWslCwd, WSL_PROBE_TIMEOUT_MS } from '../wsl';

type Callback = (error: Error | null, stdout: string, stderr: string) => void;
const finish = (call: number, cwd = '/project') => (exec.mock.calls[call][3] as Callback)(null, `Ubuntu\0user\0${cwd}\0`, '');
beforeEach(() => exec.mockReset());

describe('asynchronous WSL probes', () => {
  it('coalesces simultaneous requests without blocking the event loop or caching stale cwd validity', async () => {
    const first = resolveWslCwd('wsl.exe', '/project');
    const second = resolveWslCwd('wsl.exe', '/project');
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][2].timeout).toBe(WSL_PROBE_TIMEOUT_MS);
    let ticked = false;
    await new Promise<void>((resolve) => setTimeout(() => { ticked = true; resolve(); }, 1));
    expect(ticked).toBe(true);
    finish(0);
    expect(await first).toEqual(await second);
    const retry = resolveWslCwd('wsl.exe', '/project');
    expect(exec).toHaveBeenCalledTimes(2);
    finish(1); await retry;
  });

  it('starts distinct targets concurrently and evicts failed probes for retry', async () => {
    const failed = resolveWslCwd('wsl.exe', '/missing');
    const other = resolveWslCwd('wsl.exe', '/other', { distribution: 'Other', user: 'user' });
    expect(exec).toHaveBeenCalledTimes(2);
    const rejection = expect(failed).rejects.toThrow('directory missing');
    (exec.mock.calls[0][3] as Callback)(new Error('failed'), '', 'directory missing');
    finish(1, '/other'); await other; await rejection;
    const retry = resolveWslCwd('wsl.exe', '/missing');
    expect(exec).toHaveBeenCalledTimes(3);
    finish(2, '/missing'); await retry;
  });
});
