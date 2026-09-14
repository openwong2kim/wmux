import { describe, it, expect, vi, beforeEach } from 'vitest';

// Local-mode WSL create: the cwd probe is async, so a pane can be disposed
// while it is still pending. dispose(id) in that window must cancel the spawn.
const { spawn, resolveWslCwd } = vi.hoisted(() => ({
  spawn: vi.fn(() => ({ pid: 0, kill() {} })),
  resolveWslCwd: vi.fn(),
}));
vi.mock('node-pty', () => ({ spawn, default: { spawn } }));
vi.mock('../../../shared/wsl', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/wsl')>()),
  // The real check is win32-only; pretend to be Windows for the WSL branch.
  isWslShell: (shell?: string) => /(^|[\\/])wsl(\.exe)?$/i.test(shell ?? ''),
  resolveWslCwd,
}));
vi.mock('../../../shared/wslIntegration', () => ({
  buildWslInjection: () => ({ args: [], env: {} }),
}));
import { PTYManager } from '../PTYManager';

function deferredProbe() {
  let resolve!: (value: unknown) => void;
  resolveWslCwd.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  return (cwd: string) => resolve({ cwd, target: { distribution: 'Ubuntu', user: 'dev' } });
}

describe('PTYManager.createAsync cancellation', () => {
  beforeEach(() => {
    spawn.mockClear();
    resolveWslCwd.mockReset();
  });

  it('does not spawn when the reserved id is disposed while the WSL probe is pending', async () => {
    const manager = new PTYManager();
    const finishProbe = deferredProbe();
    const pending = manager.createAsync({ shell: 'wsl.exe' });
    // First reservation on a fresh manager.
    manager.dispose('pty-1');
    finishProbe('/home/dev');
    await expect(pending).rejects.toThrow('PTY creation cancelled');
    expect(spawn).not.toHaveBeenCalled();
    expect(manager.get('pty-1')).toBeUndefined();
  });

  it('spawns under the reserved id when nothing cancels the probe', async () => {
    const manager = new PTYManager();
    const finishProbe = deferredProbe();
    const pending = manager.createAsync({ shell: 'wsl.exe' });
    finishProbe('/home/dev');
    try {
      const instance = await pending;
      expect(instance.id).toBe('pty-1');
      expect(instance.cwd).toBe('/home/dev');
      expect(spawn).toHaveBeenCalledOnce();
    } finally { manager.disposeAll(); }
  });
});
