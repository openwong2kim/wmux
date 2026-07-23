/**
 * A1 projection selector reference-cache contract (review fix — 3-model consensus hotspot).
 *
 * The first projections created fresh element objects on every call, so zustand useShallow
 * (per-element Object.is) always failed — a defect that nullified rerender reduction. This
 * test pins the reference-cache contract directly:
 *   (1) Unchanged watched fields → **same array reference** (prerequisite for zero rerenders),
 *   (2) Partial item changes → new array but unchanged elements **reuse prior references**,
 *   (3) Unwatched field changes (cwd etc.) → array reference unchanged.
 * Complements component mount probes (rerenderRegression.dynamic) — validates the selector
 * layer contract without mount friction.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../index';
import {
  selectWorkspaceIdName,
  selectWorkspaceRailSummary,
  selectWorkspaceMuteRows,
} from '../workspaceProjections';
import type { SessionData } from '../../../../shared/types';

function makeWorkspace(id: string, name: string): SessionData['workspaces'][number] {
  return {
    id,
    name,
    rootPane: {
      id: `${id}-pane`,
      type: 'leaf',
      surfaces: [{ id: `${id}-surf`, ptyId: `${id}-pty`, title: 't', shell: 'zsh', cwd: '/x' }],
      activeSurfaceId: `${id}-surf`,
    },
    activePaneId: `${id}-pane`,
  } as SessionData['workspaces'][number];
}

beforeEach(() => {
  useStore.getState().loadSession({
    workspaces: [makeWorkspace('ws-1', 'Alpha'), makeWorkspace('ws-2', 'Bravo')],
    activeWorkspaceId: 'ws-1',
    sidebarVisible: true,
  });
});

describe('workspaceProjections — reference cache contract', () => {
  it('IdName array reference unchanged on out-of-interest change (surface title)', () => {
    const before = selectWorkspaceIdName(useStore.getState());
    useStore.getState().updateSurfaceTitleByPty('ws-2-pty', 'changed');
    const after = selectWorkspaceIdName(useStore.getState());
    // Whole-tree workspaces reference changes (immer), but name is unchanged so projection cache hits.
    expect(after).toBe(before);
  });

  it('name change → new array — unchanged elements reuse prior references', () => {
    const before = selectWorkspaceIdName(useStore.getState());
    useStore.getState().renameWorkspace('ws-2', 'Bravo2');
    const after = selectWorkspaceIdName(useStore.getState());
    expect(after).not.toBe(before);
    expect(after[0]).toBe(before[0]); // ws-1 element reference reused.
    expect(after[1]).not.toBe(before[1]);
    expect(after[1].name).toBe('Bravo2');
  });

  it('RailSummary invariant on cwd/git change, reacts only to agentStatus change', () => {
    const s0 = selectWorkspaceRailSummary(useStore.getState());
    useStore.getState().updateWorkspaceMetadata('ws-2', { cwd: '/new', gitBranch: 'feat' });
    const s1 = selectWorkspaceRailSummary(useStore.getState());
    expect(s1).toBe(s0); // Not rail watched fields — array reference preserved.
    useStore.getState().updateWorkspaceMetadata('ws-2', { agentStatus: 'running' });
    const s2 = selectWorkspaceRailSummary(useStore.getState());
    expect(s2).not.toBe(s1);
    expect(s2[0]).toBe(s1[0]); // ws-1 element reused.
    expect(s2[1].agentStatus).toBe('running');
  });

  it('MuteRows reacts only to mute toggle', () => {
    const m0 = selectWorkspaceMuteRows(useStore.getState());
    useStore.getState().updateSurfaceTitleByPty('ws-1-pty', 'noise');
    expect(selectWorkspaceMuteRows(useStore.getState())).toBe(m0);
    useStore.getState().updateWorkspaceMetadata('ws-1', { notificationsMuted: true });
    const m1 = selectWorkspaceMuteRows(useStore.getState());
    expect(m1).not.toBe(m0);
    expect(m1[0].notificationsMuted).toBe(true);
    expect(m1[1]).toBe(m0[1]);
  });

  it('add/remove updates array (structural change — cache does not hide deletion)', () => {
    const before = selectWorkspaceIdName(useStore.getState());
    useStore.getState().loadSession({
      workspaces: [makeWorkspace('ws-1', 'Alpha')],
      activeWorkspaceId: 'ws-1',
      sidebarVisible: true,
    });
    const after = selectWorkspaceIdName(useStore.getState());
    expect(after).not.toBe(before);
    expect(after).toHaveLength(1);
  });
});
