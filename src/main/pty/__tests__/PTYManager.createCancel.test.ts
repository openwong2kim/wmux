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

  // #1305 — dispose(id) can only be called by someone who knows the id, and the
  // id is exactly what the create has not returned yet. The surface is the
  // handle the caller does have.
  it('cancels a pending create by the surface that asked for it', async () => {
    const manager = new PTYManager();
    const finishProbe = deferredProbe();
    const pending = manager.createAsync({ shell: 'wsl.exe', surfaceId: 'surface-1' });

    expect(manager.cancelPendingCreate('surface-1')).toBe(true);
    finishProbe('/home/dev');

    await expect(pending).rejects.toThrow('PTY creation cancelled');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('answers false for a surface with nothing in flight, and after the spawn', async () => {
    const manager = new PTYManager();
    // Never asked for anything.
    expect(manager.cancelPendingCreate('surface-unknown')).toBe(false);

    const finishProbe = deferredProbe();
    const pending = manager.createAsync({ shell: 'wsl.exe', surfaceId: 'surface-1' });
    finishProbe('/home/dev');
    const instance = await pending;
    try {
      // Resolved: the caller has the id now, so this is its pty to dispose —
      // a late cancel must not claim to have stopped anything.
      expect(manager.cancelPendingCreate('surface-1')).toBe(false);
      expect(manager.get(instance.id)).toBeDefined();
    } finally { manager.disposeAll(); }
  });

  // A surface can hold two probes at once — a respawn started while the first
  // was still resolving. Its close means NONE of them should reach a spawn:
  // cancelling only the newest left the earlier one to start a shell after the
  // pane was gone (review: CodeRabbit).
  it('cancels every create the surface has in flight, not just the newest', async () => {
    const manager = new PTYManager();
    const finishFirst = deferredProbe();
    const first = manager.createAsync({ shell: 'wsl.exe', surfaceId: 'surface-1' });
    const finishSecond = deferredProbe();
    const second = manager.createAsync({ shell: 'wsl.exe', surfaceId: 'surface-1' });

    expect(manager.cancelPendingCreate('surface-1')).toBe(true);
    finishFirst('/home/dev');
    finishSecond('/home/dev');

    await expect(first).rejects.toThrow('PTY creation cancelled');
    await expect(second).rejects.toThrow('PTY creation cancelled');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('forgets a surface once its creates settle, so a later cancel claims nothing', async () => {
    const manager = new PTYManager();
    const finishProbe = deferredProbe();
    const pending = manager.createAsync({ shell: 'wsl.exe', surfaceId: 'surface-1' });
    finishProbe('/home/dev');
    await pending;
    try {
      expect(manager.cancelPendingCreate('surface-1')).toBe(false);
    } finally { manager.disposeAll(); }
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
