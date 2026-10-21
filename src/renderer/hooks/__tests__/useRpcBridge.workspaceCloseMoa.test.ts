// @vitest-environment jsdom
// `workspace.close` asks the shared pre-close check before any dispose: the
// last workspace is never closed. A refusal after the dispose would leave the
// workspace open, dead and empty. An earlier version's HQ workspace is an
// ordinary workspace now.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pane, Workspace } from '../../../shared/types';
import { useStore } from '../../stores';
import { handleRpcMethod } from '../useRpcBridge';

function ws(id: string): Workspace {
  const rootPane: Pane = {
    id: `${id}-p`, type: 'leaf', activeSurfaceId: `${id}-s`,
    surfaces: [{ id: `${id}-s`, ptyId: `pty-${id}`, title: '', shell: 'zsh', cwd: '/r', surfaceType: 'terminal' }],
  };
  return { id, name: id, rootPane, activePaneId: `${id}-p` };
}
let dispose: ReturnType<typeof vi.fn>;
beforeEach(() => {
  dispose = vi.fn(() => Promise.resolve());
  (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { dispose } };
  useStore.setState({ paneGate: 'ready', surfaceAgent: {} });
});

describe('workspace.close and the last workspace', () => {
  it('[A]: closing A is refused with an error and nothing is disposed', async () => {
    useStore.setState({ workspaces: [ws('a')], activeWorkspaceId: 'a' });
    const res = await handleRpcMethod('workspace.close', { id: 'a' }) as { error?: string; ok?: boolean };
    expect(res.error).toMatch(/only workspace/);
    expect(dispose).not.toHaveBeenCalled();
    expect(useStore.getState().workspaces.map((w) => w.id)).toEqual(['a']);
  });

  it('an earlier version\'s HQ workspace closes like any other, whatever localStorage remembers', async () => {
    localStorage.setItem('wmux.moa.hqWorkspaceId', 'hq');
    try {
      useStore.setState({ workspaces: [ws('hq'), ws('a')], activeWorkspaceId: 'a' });
      const res = await handleRpcMethod('workspace.close', { id: 'hq' }) as { ok?: boolean };
      expect(res.ok).toBe(true);
      expect(dispose).toHaveBeenCalledWith('pty-hq');
      expect(useStore.getState().workspaces.map((w) => w.id)).toEqual(['a']);
    } finally {
      localStorage.clear();
    }
  });
});

describe('workspace.close and live agent panes', () => {
  it('a workspace with a running agent is refused without force and nothing is disposed', async () => {
    useStore.setState({
      workspaces: [ws('a'), ws('b')], activeWorkspaceId: 'a',
      surfaceAgent: { 'pty-b': { name: 'Claude Code', status: 'idle' } },
    });
    const res = await handleRpcMethod('workspace.close', { id: 'b' }) as { error?: string };
    expect(res.error).toMatch(/1 agent pane\(s\) are still running in it \(Claude Code\).*--force/);
    expect(dispose).not.toHaveBeenCalled();
    expect(useStore.getState().workspaces.map((w) => w.id)).toEqual(['a', 'b']);
  });

  it('with force it closes', async () => {
    useStore.setState({
      workspaces: [ws('a'), ws('b')], activeWorkspaceId: 'a',
      surfaceAgent: { 'pty-b': { name: 'Claude Code', status: 'idle' } },
    });
    const res = await handleRpcMethod('workspace.close', { id: 'b', force: true }) as { ok?: boolean };
    expect(res.ok).toBe(true);
    expect(dispose).toHaveBeenCalledWith('pty-b');
  });

  it('a workspace that owns a remote session is refused without force (no local pty to detect an agent in)', async () => {
    const remote = ws('r');
    (remote.rootPane as { surfaces: unknown[] }).surfaces = [{
      id: 'r-s', ptyId: '', title: '', shell: '', cwd: '', surfaceType: 'remote-terminal',
      remoteOwned: true, remoteHostId: 'host-1', remoteSessionId: 'sess-1',
    } as never];
    useStore.setState({ workspaces: [ws('a'), remote], activeWorkspaceId: 'a' });
    const res = await handleRpcMethod('workspace.close', { id: 'r' }) as { error?: string };
    expect(res.error).toMatch(/1 remote session\(s\).*--force/);
    expect(useStore.getState().workspaces.map((w) => w.id)).toEqual(['a', 'r']);
  });
});

