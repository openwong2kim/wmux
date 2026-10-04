// @vitest-environment jsdom
// `workspace.close` asks the shared pre-close check before any dispose: Moa's
// HQ is never closed, and it does not count toward the last-workspace guard.
// With [HQ, A], closing A used to pass the total-count check, dispose A's
// sessions, and then have removeWorkspace refuse — A left open, dead and empty.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pane, Workspace } from '../../../shared/types';
import type { MoaState } from '../../../shared/moa';
import { useStore } from '../../stores';
import { handleRpcMethod } from '../useRpcBridge';

function ws(id: string): Workspace {
  const rootPane: Pane = {
    id: `${id}-p`, type: 'leaf', activeSurfaceId: `${id}-s`,
    surfaces: [{ id: `${id}-s`, ptyId: `pty-${id}`, title: '', shell: 'zsh', cwd: '/r', surfaceType: 'terminal' }],
  };
  return { id, name: id, rootPane, activePaneId: `${id}-p` };
}
function moa(hq: string | null): MoaState {
  return {
    config: { enabled: true, onboarded: true, level: 1, maxTurnsPerHour: 20, bubbles: true, reduceMotion: false, defaultReason: null },
    hq: { workspaceId: hq, state: hq ? 'ok' : 'unset' },
    archive: { unacked: 0, total: 0 },
  };
}

let dispose: ReturnType<typeof vi.fn>;
beforeEach(() => {
  dispose = vi.fn(() => Promise.resolve());
  (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { dispose } };
  useStore.setState({ paneGate: 'ready' });
});

describe('workspace.close and Moa', () => {
  it('[HQ, A]: closing A is refused with an error and nothing is disposed', async () => {
    useStore.setState({ workspaces: [ws('hq'), ws('a')], activeWorkspaceId: 'a', moa: moa('hq'), moaHqSeed: null });
    const res = await handleRpcMethod('workspace.close', { id: 'a' }) as { error?: string; ok?: boolean };
    expect(res.error).toMatch(/only workspace/);
    expect(dispose).not.toHaveBeenCalled();
    expect(useStore.getState().workspaces.map((w) => w.id)).toEqual(['hq', 'a']);
  });

  it('closing the HQ itself is refused with an error and nothing is disposed', async () => {
    useStore.setState({ workspaces: [ws('hq'), ws('a'), ws('b')], activeWorkspaceId: 'a', moa: moa('hq'), moaHqSeed: null });
    const res = await handleRpcMethod('workspace.close', { id: 'hq' }) as { error?: string };
    expect(res.error).toMatch(/Moa's workspace/);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('before main answers, the remembered HQ id guards the same way', async () => {
    useStore.setState({ workspaces: [ws('hq'), ws('a')], activeWorkspaceId: 'a', moa: null, moaHqSeed: 'hq' });
    const res = await handleRpcMethod('workspace.close', { id: 'a' }) as { error?: string };
    expect(res.error).toMatch(/only workspace/);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('[HQ, A, B]: closing A still goes through', async () => {
    useStore.setState({ workspaces: [ws('hq'), ws('a'), ws('b')], activeWorkspaceId: 'a', moa: moa('hq'), moaHqSeed: null });
    const res = await handleRpcMethod('workspace.close', { id: 'a' }) as { ok?: boolean };
    expect(res.ok).toBe(true);
    expect(dispose).toHaveBeenCalledWith('pty-a');
    expect(useStore.getState().workspaces.map((w) => w.id)).toEqual(['hq', 'b']);
  });
});
