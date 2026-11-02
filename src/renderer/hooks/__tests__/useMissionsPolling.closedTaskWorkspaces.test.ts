// @vitest-environment jsdom
//
// #2934 — a mission refresh that sees a task go from open to closed closes the
// task's workspace with the UI close's teardown, unless the workspace is kept.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Pane, Workspace } from '../../../shared/types';
import type { WorkTask } from '../../../shared/workTask';

const mocks = vi.hoisted(() => ({ dispose: vi.fn() }));

vi.mock('../../utils/paneTeardown', () => ({ disposeWorkspacePtys: mocks.dispose }));

vi.mock('../../stores', async () => {
  const { create } = await import('zustand');
  const useStore = create(() => ({
    workspaces: [] as Workspace[],
    activeWorkspaceId: 'owner',
    missionByPaneGroup: {} as Record<string, WorkTask>,
    removeWorkspace: (id: string) =>
      useStore.setState((s) => ({ workspaces: s.workspaces.filter((w) => w.id !== id) })),
    // The roster's inputs (what the sidebar reads an agent's status from).
    surfaceAgent: {} as Record<string, { name: string; status: string }>,
    surfaceAgentStatus: {},
    surfacePendingQuestion: {},
    surfaceQuestionSeen: {},
    surfaceActivity: {},
    surfaceActivityAt: {},
    surfaceTurnOpenAt: {},
    paneLabel: {},
    agentClockMs: 1_000_000,
    remoteWorkspaces: [],
    // The refresh passes the mount starts.
    refreshFanoutProvenance: vi.fn(async () => undefined),
    refreshMissionsForOwners: vi.fn(async () => undefined),
    markFanoutRefreshSettled: vi.fn(),
  }));
  return { useStore };
});

import { useStore as realUseStore } from '../../stores';
import { useMissionsPolling } from '../useMissionsPolling';

const useStore = realUseStore as unknown as {
  getState: () => { workspaces: Workspace[] };
  setState: (partial: Record<string, unknown>) => void;
};

function workspace(id: string): Workspace {
  const rootPane: Pane = {
    id: `${id}-p`, type: 'leaf', activeSurfaceId: `${id}-s`,
    surfaces: [{ id: `${id}-s`, ptyId: `${id}-pty`, title: id, shell: 'zsh', cwd: '/r', surfaceType: 'terminal' }],
  };
  return { id, name: id, rootPane, activePaneId: rootPane.id };
}

function task(wsId: string, status: WorkTask['status'], extra: Partial<WorkTask> = {}): WorkTask {
  const ref = { verifiedWorkspaceId: 'owner' } as WorkTask['owner'];
  return {
    id: `task-${wsId}`, title: wsId, status, missionChannelId: 'ch', createdAt: 1,
    createdBy: ref, owner: ref, paneGroupId: wsId, ...extra,
  };
}

/** Every task of `ids` with `status` (plus per-task extras), as the cache index. */
function index(ids: string[], status: WorkTask['status'], extra: Record<string, Partial<WorkTask>> = {}): Record<string, WorkTask> {
  return Object.fromEntries(ids.map((id) => [id, task(id, status, extra[id])]));
}

function Harness(): null {
  useMissionsPolling();
  return null;
}

const liveIds = (): string[] => useStore.getState().workspaces.map((w) => w.id);

describe('useMissionsPolling — closed task workspaces (#2934)', () => {
  let root: Root;

  beforeEach(async () => {
    mocks.dispose.mockClear();
    const ids = ['t1', 't-detached', 't-active', 't-busy'];
    useStore.setState({
      workspaces: [workspace('owner'), ...ids.map(workspace)],
      activeWorkspaceId: 'owner',
      missionByPaneGroup: index(ids, 'open'),
      surfaceAgent: { 't-busy-pty': { name: 'Claude Code', status: 'awaiting_input' } },
    });
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      daemon: { whenReady: () => new Promise<void>(() => undefined), onConnected: () => () => undefined },
    };
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    root = createRoot(document.createElement('div'));
    await React.act(async () => {
      root.render(React.createElement(Harness));
    });
  });

  afterEach(() => {
    React.act(() => root.unmount());
  });

  it('disposes and removes the workspace of a task that closed; detached, active and busy ones stay', () => {
    useStore.setState({ activeWorkspaceId: 't-active' });
    useStore.setState({
      missionByPaneGroup: index(['t1', 't-detached', 't-active', 't-busy'], 'closed', { 't-detached': { detachedAt: 5 } }),
    });
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.dispose.mock.calls[0][0]).toMatchObject({ id: 't1' });
    expect(liveIds()).toEqual(['owner', 't-detached', 't-active', 't-busy']);
  });

  it('stops closing once unmounted', () => {
    React.act(() => root.unmount());
    useStore.setState({ missionByPaneGroup: index(['t1'], 'closed') });
    expect(mocks.dispose).not.toHaveBeenCalled();
    expect(liveIds()).toContain('t1');
    // afterEach unmounts again; give it a fresh root to unmount.
    root = createRoot(document.createElement('div'));
  });
});
