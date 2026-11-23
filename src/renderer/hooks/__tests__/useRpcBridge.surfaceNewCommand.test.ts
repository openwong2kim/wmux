// @vitest-environment jsdom
//
// surface.new with an explicit startup command (main's "Log in to Claude"
// tab): the tab runs that command as a plain user shell, and it replaces the
// workspace profile's default pane command instead of being replaced by it —
// the shape accountLogin.openTerminalTab uses.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneLeaf, Workspace } from '../../../shared/types';
import { useStore } from '../../stores';
import { handleRpcMethod, surfaceNewInitialCommand, SURFACE_NEW_COMMAND_MAX } from '../useRpcBridge';

let create: ReturnType<typeof vi.fn>;

function workspace(): Workspace {
  const leaf: PaneLeaf = { id: 'pane-1', type: 'leaf', surfaces: [], activeSurfaceId: '' } as unknown as PaneLeaf;
  return {
    id: 'ws-1',
    name: 'api',
    rootPane: leaf,
    activePaneId: 'pane-1',
    profile: { defaultPaneCommand: 'claude --resume', env: { A: '1' } },
  } as unknown as Workspace;
}

beforeEach(() => {
  create = vi.fn(async () => ({ id: 'pty-new', shell: 'zsh', cwd: '/home' }));
  (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { create, dispose: vi.fn() } };
  useStore.setState({ workspaces: [workspace()], activeWorkspaceId: 'ws-1', paneGate: 'ready' } as never);
});

describe('surface.new initialCommand', () => {
  it('runs the given command as a user shell, over the profile\'s default pane command', async () => {
    await handleRpcMethod('surface.new', { workspaceId: 'ws-1', initialCommand: 'claude /login' });
    const opts = create.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.initialCommand).toBe('claude /login');
    expect(opts.spawnKind).toBe('user-shell');
    // The profile's env still applies.
    expect(opts.env).toEqual({ A: '1' });
  });

  it('only main\'s sign-in tab stays out of the worker fence a profile turns on for new panes', async () => {
    const ws = workspace();
    ws.profile = { ...ws.profile, fenceAgents: true };
    useStore.setState({ workspaces: [ws] } as never);
    await handleRpcMethod('surface.new', { workspaceId: 'ws-1', initialCommand: 'claude auth login', signIn: true });
    expect((create.mock.calls[0][0] as Record<string, unknown>).workerFence).toBe(false);
    await handleRpcMethod('surface.new', { workspaceId: 'ws-1' });
    expect((create.mock.calls[1][0] as Record<string, unknown>).workerFence).toBe(true);
    // Any other startup command follows the profile.
    await handleRpcMethod('surface.new', { workspaceId: 'ws-1', initialCommand: 'claude' });
    expect((create.mock.calls[2][0] as Record<string, unknown>).workerFence).toBe(true);
    // The flag alone, with no command, opts nothing out.
    await handleRpcMethod('surface.new', { workspaceId: 'ws-1', signIn: true });
    expect((create.mock.calls[3][0] as Record<string, unknown>).workerFence).toBe(true);
  });

  it('without one, the profile\'s default pane command stands and no spawn kind is set', async () => {
    await handleRpcMethod('surface.new', { workspaceId: 'ws-1' });
    const opts = create.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.initialCommand).toBe('claude --resume');
    expect(opts.spawnKind).toBeUndefined();
  });

  it('refuses a command that is not a non-empty string within the bound, creating nothing', async () => {
    for (const bad of ['', '   ', 42, 'x'.repeat(SURFACE_NEW_COMMAND_MAX + 1)]) {
      const r = await handleRpcMethod('surface.new', { workspaceId: 'ws-1', initialCommand: bad as never });
      expect(r).toEqual({ error: 'surface.new: initialCommand must be a non-empty string' });
    }
    expect(create).not.toHaveBeenCalled();
    expect(surfaceNewInitialCommand(undefined)).toBeUndefined();
  });
});
