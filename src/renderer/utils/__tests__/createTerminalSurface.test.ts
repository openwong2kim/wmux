import { describe, expect, it, vi } from 'vitest';
import { createTerminalSurface, type CreateTerminalSurfaceDeps } from '../createTerminalSurface';

function makeDeps(overrides: Partial<CreateTerminalSurfaceDeps> = {}): CreateTerminalSurfaceDeps {
  const ptyCreate = vi.fn().mockResolvedValue({ id: 'pty-2', cwd: 'D:/repo' });
  const ipcInvoke: CreateTerminalSurfaceDeps['ipcInvoke'] = async <T>(call: () => Promise<T>) => ({
    ok: true as const,
    data: await call(),
  });

  return {
    workspaceId: 'ws-2',
    paneId: 'pane-2',
    paneGate: 'ready',
    workspaces: [{ id: 'ws-2' }],
    startupDirectory: 'D:/fallback',
    defaultShell: 'pwsh',
    ptyCreate,
    ipcInvoke,
    addSurface: vi.fn(),
    ...overrides,
  };
}

describe('createTerminalSurface', () => {
  it('adds a created terminal to the requested workspace and pane', async () => {
    const deps = makeDeps();

    await createTerminalSurface(deps);

    expect(deps.ptyCreate).toHaveBeenCalledOnce();
    expect(deps.addSurface).toHaveBeenCalledWith('pane-2', 'pty-2', 'Terminal', 'D:/repo', 'ws-2');
  });

  it('does nothing while the pane gate is not ready', async () => {
    const deps = makeDeps({ paneGate: 'pending' });

    await createTerminalSurface(deps);

    expect(deps.ptyCreate).not.toHaveBeenCalled();
    expect(deps.addSurface).not.toHaveBeenCalled();
  });

  it('does nothing when the requested workspace is missing', async () => {
    const deps = makeDeps({ workspaces: [{ id: 'other-workspace' }] });

    await createTerminalSurface(deps);

    expect(deps.ptyCreate).not.toHaveBeenCalled();
    expect(deps.addSurface).not.toHaveBeenCalled();
  });

  it('does not add a surface when IPC reports a failed PTY creation', async () => {
    const deps = makeDeps({
      ipcInvoke: vi.fn().mockResolvedValue({ ok: false, error: { code: 'RESOURCE_EXHAUSTED' } }),
    });

    await createTerminalSurface(deps);

    expect(deps.ptyCreate).not.toHaveBeenCalled();
    expect(deps.addSurface).not.toHaveBeenCalled();
  });

  it('uses an empty cwd when PTY creation returns no cwd', async () => {
    const deps = makeDeps({
      ptyCreate: vi.fn().mockResolvedValue({ id: 'pty-3' }),
    });

    await createTerminalSurface(deps);

    expect(deps.addSurface).toHaveBeenCalledWith('pane-2', 'pty-3', 'Terminal', '', 'ws-2');
  });

  it('uses the requested workspace and pane IDs even when a different workspace comes first in the list', async () => {
    const deps = makeDeps({
      workspaces: [
        { id: 'ws-1', profile: { startupCwd: 'D:/ws1' } },
        { id: 'ws-2', profile: { startupCwd: 'D:/ws2' } },
      ],
    });

    await createTerminalSurface(deps);

    expect(deps.ptyCreate).toHaveBeenCalledOnce();
    const options = (deps.ptyCreate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.workspaceId).toBe('ws-2');
    expect(deps.addSurface).toHaveBeenCalledWith('pane-2', 'pty-2', 'Terminal', 'D:/repo', 'ws-2');
  });

  it('passes a rejected ptyCreate through ipcInvoke and adds no surface', async () => {
    const ptyCreate = vi.fn().mockRejectedValue(new Error('PTY spawn failed'));
    // A wrapper that mirrors the real `createInvoke`: it runs the call and,
    // on rejection, folds into { ok: false } (owning the toast) instead of
    // re-throwing, so the helper's await resolves on the failure branch.
    const ipcInvoke: CreateTerminalSurfaceDeps['ipcInvoke'] = async <T>(call: () => Promise<T>) => {
      try {
        return { ok: true as const, data: await call() };
      } catch {
        return { ok: false as const, error: { code: 'UNKNOWN' as const, message: 'failure', original: undefined } };
      }
    };
    const addSurface = vi.fn();

    await createTerminalSurface(makeDeps({ ptyCreate, ipcInvoke, addSurface }));

    expect(ptyCreate).toHaveBeenCalledOnce();
    expect(addSurface).not.toHaveBeenCalled();
  });
});
