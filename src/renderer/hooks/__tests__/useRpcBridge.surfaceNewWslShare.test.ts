// @vitest-environment jsdom
//
// surface.new (CLI `wmux new-surface`, MCP surface_new) in a workspace whose
// folder is a WSL share: the Settings default shell is a choice made for
// Windows folders, so it is not filled in and main starts WSL in that distro,
// as Ctrl+T and splits do. A shell the caller names is still kept.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneLeaf, Workspace } from '../../../shared/types';
import { useStore } from '../../stores';
import { handleRpcMethod } from '../useRpcBridge';

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const SHARE = '\\\\wsl.localhost\\Ubuntu\\tmp';

let create: ReturnType<typeof vi.fn>;

function workspace(startupCwd?: string): Workspace {
  const leaf: PaneLeaf = { id: 'pane-1', type: 'leaf', surfaces: [], activeSurfaceId: '' } as unknown as PaneLeaf;
  return {
    id: 'ws-1',
    name: 'tmp',
    rootPane: leaf,
    activePaneId: 'pane-1',
    ...(startupCwd ? { profile: { startupCwd } } : {}),
  } as unknown as Workspace;
}

function arrange(startupCwd?: string): void {
  useStore.setState({
    workspaces: [workspace(startupCwd)],
    activeWorkspaceId: 'ws-1',
    paneGate: 'ready',
    defaultShell: POWERSHELL,
    startupDirectory: '',
  } as never);
}

const lastCreate = (): Record<string, unknown> => create.mock.calls[0][0] as Record<string, unknown>;

beforeEach(() => {
  create = vi.fn(async () => ({ id: 'pty-new', shell: '', cwd: '' }));
  (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { create, dispose: vi.fn() } };
});

describe('surface.new in a WSL share folder', () => {
  it('leaves the default shell out for the profile\'s share folder', async () => {
    arrange(SHARE);
    await handleRpcMethod('surface.new', { workspaceId: 'ws-1' });
    expect(lastCreate().cwd).toBe(SHARE);
    expect(lastCreate().shell).toBeUndefined();
  });

  it('leaves the default shell out for a share folder the caller passes', async () => {
    arrange();
    await handleRpcMethod('surface.new', { workspaceId: 'ws-1', cwd: SHARE });
    expect(lastCreate().cwd).toBe(SHARE);
    expect(lastCreate().shell).toBeUndefined();
  });

  it('keeps a shell the caller names', async () => {
    arrange(SHARE);
    await handleRpcMethod('surface.new', { workspaceId: 'ws-1', shell: POWERSHELL });
    expect(lastCreate().shell).toBe(POWERSHELL);
  });

  it('still fills the default shell in for a Windows folder', async () => {
    arrange('C:\\work');
    await handleRpcMethod('surface.new', { workspaceId: 'ws-1' });
    expect(lastCreate().cwd).toBe('C:\\work');
    expect(lastCreate().shell).toBe(POWERSHELL);
  });
});
