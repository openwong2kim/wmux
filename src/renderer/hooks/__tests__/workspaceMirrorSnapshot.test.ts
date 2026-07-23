import { describe, it, expect } from 'vitest';
import {
  findActivePtyId,
  collectAllPtyIds,
  buildWorkspaceListEntries,
  buildFleetSnapshots,
  buildWorkspaceMirrorPayload,
} from '../workspaceMirrorSnapshot';
import type { Workspace, Pane, Surface, AgentStatus } from '../../../shared/types';
import type { FleetSelectorState } from '../../stores/selectors/fleet';

// ─── Fixtures (mirror fleet.test.ts) ─────────────────────────────────────────

function surface(id: string, ptyId: string, extra: Partial<Surface> = {}): Surface {
  return { id, ptyId, title: id, shell: 'pwsh', cwd: `C:\\repo\\${id}`, surfaceType: 'terminal', ...extra };
}
function leaf(id: string, surfaces: Surface[], activeSurfaceId?: string): Pane {
  return { id, type: 'leaf', surfaces, activeSurfaceId: activeSurfaceId ?? surfaces[0]?.id ?? '' };
}
function branch(id: string, children: Pane[]): Pane {
  return { id, type: 'branch', direction: 'horizontal', children };
}
function workspace(
  id: string,
  name: string,
  rootPane: Pane,
  activePaneId: string,
  metadata?: Workspace['metadata'],
): Workspace {
  return { id, name, rootPane, activePaneId, metadata };
}

const w1 = workspace(
  'ws-1', 'alpha',
  leaf('p1', [surface('s1', 'pty-1')]),
  'p1',
  { cwd: 'C:/repo/alpha', gitBranch: 'main', agentName: 'Claude Code', agentStatus: 'running' },
);
// ws-2: branch, active leaf p2a has two surfaces (must pick activeSurfaceId).
const w2 = workspace(
  'ws-2', 'beta',
  branch('b', [
    leaf('p2a', [surface('s2a-first', 'pty-2a-first'), surface('s2a', 'pty-2a')], 's2a'),
    leaf('p2b', [surface('s2b', 'pty-2b', { surfaceType: 'browser' })]),
  ]),
  'p2a',
  { agentName: 'Codex', agentStatus: 'running' },
);

const surfaceAgentStatus: Record<string, AgentStatus> = {
  'pty-1': 'awaiting_input',
  'pty-2b': 'complete',
};

function state(): FleetSelectorState {
  return {
    workspaces: [w1, w2],
    surfaceAgentStatus,
    surfaceActivity: {},
  };
}

describe('findActivePtyId / collectAllPtyIds', () => {
  it('resolves the active pane + active surface pty', () => {
    expect(findActivePtyId(w1.rootPane, w1.activePaneId)).toBe('pty-1');
    // p2a active surface is s2a → pty-2a (NOT surfaces[0]).
    expect(findActivePtyId(w2.rootPane, w2.activePaneId)).toBe('pty-2a');
  });
  it('collects every surface pty across the whole tree', () => {
    expect(collectAllPtyIds(w2.rootPane)).toEqual(['pty-2a-first', 'pty-2a', 'pty-2b']);
  });
});

describe('buildWorkspaceListEntries', () => {
  it('produces the workspace.list-shaped entries with metadata nulls filled', () => {
    const entries = buildWorkspaceListEntries([w1, w2]);
    expect(entries[0]).toEqual({
      id: 'ws-1',
      name: 'alpha',
      metadata: {
        cwd: 'C:/repo/alpha',
        gitBranch: 'main',
        agentName: 'Claude Code',
        agentStatus: 'running',
        status: null,
        progress: null,
      },
      activePtyId: 'pty-1',
      ptyIds: ['pty-1'],
    });
    expect(entries[1].activePtyId).toBe('pty-2a');
    expect(entries[1].ptyIds).toEqual(['pty-2a-first', 'pty-2a', 'pty-2b']);
  });
});

describe('buildFleetSnapshots', () => {
  it('rolls selectFleetPanes into one snapshot per workspace with ts stamped', () => {
    const fleets = buildFleetSnapshots(state(), 7777);
    const byId = Object.fromEntries(fleets.map((f) => [f.workspaceId, f]));
    expect(Object.keys(byId).sort()).toEqual(['ws-1', 'ws-2']);
    expect(byId['ws-1'].ts).toBe(7777);
    // ws-1 single active pane: attention status awaiting_input wins over ws meta.
    expect(byId['ws-1'].panes[0]).toMatchObject({
      ptyId: 'pty-1',
      agentName: 'Claude Code', // active pane → agentName exposed
      agentStatus: 'awaiting_input',
      isActivePane: true,
    });
    // ws-2 background browser pane keeps its per-pty complete status; agentName
    // must NOT be borrowed from the workspace for a background pane → null.
    const bg = byId['ws-2'].panes.find((p) => p.ptyId === 'pty-2b');
    expect(bg).toMatchObject({ agentStatus: 'complete', agentName: null, isActivePane: false });
  });
});

describe('buildFleetSnapshots — single-surface byte-identical pin', () => {
  // Single-surface panes must serialize EXACTLY as the pre-surface-accuracy
  // build did (attention row when a status is retained, base row otherwise).
  it('emits one exact row per single-surface pane (attention + base)', () => {
    const ws = workspace(
      'ws-s', 'solo',
      branch('b', [
        leaf('pa', [surface('sa', 'pty-a')]), // no attention → base
        leaf('pb', [surface('sb', 'pty-b')]), // retained attention
      ]),
      'pa',
      { agentName: 'Claude Code', agentStatus: 'running' },
    );
    const st: FleetSelectorState = {
      workspaces: [ws],
      surfaceAgentStatus: { 'pty-b': 'waiting' },
      surfaceActivity: {},
    };
    const [fleet] = buildFleetSnapshots(st, 42);
    expect(fleet).toEqual({
      workspaceId: 'ws-s',
      ts: 42,
      panes: [
        // active pane, no retained attention → base status (ws meta 'running').
        {
          ptyId: 'pty-a',
          agentName: 'Claude Code',
          agentStatus: 'running',
          isActivePane: true,
          cwd: 'C:\\repo\\sa',
        },
        // background pane, retained attention → its own status; agentName null.
        {
          ptyId: 'pty-b',
          agentName: null,
          agentStatus: 'waiting',
          isActivePane: false,
          cwd: 'C:\\repo\\sb',
        },
      ],
    });
  });
});

describe('buildFleetSnapshots — surface-accurate multi-surface panes', () => {
  // The active pane p2a has two surfaces; the BACKGROUND surface (pty-2a-first)
  // is awaiting_input while the ACTIVE surface (pty-2a) is merely running. The
  // UI rollup would pin awaiting_input onto the active surface's pty (wrong
  // terminal for actuation); the mirror must not.
  function multiState(): FleetSelectorState {
    return {
      workspaces: [w2],
      surfaceAgentStatus: { 'pty-2a-first': 'awaiting_input' },
      surfaceActivity: {},
    };
  }

  it('attributes the background-tab attention to THAT surface, never the active one', () => {
    const [fleet] = buildFleetSnapshots(multiState(), 100);
    const bg = fleet.panes.find((p) => p.ptyId === 'pty-2a-first');
    expect(bg).toEqual({
      ptyId: 'pty-2a-first',
      agentName: null, // background surface of the active pane → no agentName
      agentStatus: 'awaiting_input',
      isActivePane: false, // not the active SURFACE
      cwd: 'C:\\repo\\s2a-first',
    });
    // The active surface still gets its own row, carrying the non-attention
    // (base) status — NOT the background tab's awaiting_input.
    const active = fleet.panes.find((p) => p.ptyId === 'pty-2a');
    expect(active).toMatchObject({
      ptyId: 'pty-2a',
      agentStatus: 'running',
      isActivePane: true,
      agentName: 'Codex',
    });
    // No row anywhere attributes awaiting_input to the active surface's pty.
    expect(
      fleet.panes.some((p) => p.ptyId === 'pty-2a' && p.agentStatus === 'awaiting_input'),
    ).toBe(false);
  });

  it('emits a distinct row per surface that holds its own attention status', () => {
    const st: FleetSelectorState = {
      workspaces: [w2],
      surfaceAgentStatus: { 'pty-2a-first': 'awaiting_input', 'pty-2a': 'complete' },
      surfaceActivity: {},
    };
    const [fleet] = buildFleetSnapshots(st, 1);
    const p2a = fleet.panes.filter((p) => p.ptyId === 'pty-2a-first' || p.ptyId === 'pty-2a');
    expect(p2a.map((p) => [p.ptyId, p.agentStatus, p.isActivePane])).toEqual([
      ['pty-2a-first', 'awaiting_input', false],
      ['pty-2a', 'complete', true], // active surface carries its OWN attention
    ]);
  });
});

describe('buildWorkspaceMirrorPayload', () => {
  it('stamps entries + fleets with one injected clock value', () => {
    const payload = buildWorkspaceMirrorPayload(state(), () => 5555);
    expect(payload.ts).toBe(5555);
    expect(payload.entries).toHaveLength(2);
    expect(payload.fleets.every((f) => f.ts === 5555)).toBe(true);
  });
});
