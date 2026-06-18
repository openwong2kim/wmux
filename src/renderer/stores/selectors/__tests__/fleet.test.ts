import { describe, it, expect } from 'vitest';
import {
  selectFleetPanes,
  sortFleetPanes,
  countNeedsAttention,
  type FleetPane,
} from '../fleet';
import type { Workspace, Pane, Surface, AgentStatus } from '../../../../shared/types';

// ─── Fixtures ──────────────────────────────────────────────────────────────

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

// ws-1: single active leaf. Per-pty attention status (awaiting_input) must win
// over the workspace-level metadata (running) — proves resolution precedence.
const w1 = workspace(
  'ws-1', 'alpha',
  leaf('p1', [surface('s1', 'pty-1')]),
  'p1',
  { agentName: 'Claude Code', agentStatus: 'running' },
);
// ws-2: a branch (depth-1) with two leaves. p2a (active) has two surfaces — the
// selector must pick the activeSurfaceId, not surfaces[0]. p2b (background) is a
// browser surface whose per-pty status (complete) is accurate even in the
// background, while its agentName must NOT be borrowed from the workspace.
const w2 = workspace(
  'ws-2', 'beta',
  branch('b', [
    leaf('p2a', [surface('s2a-first', 'pty-2a-first'), surface('s2a', 'pty-2a')], 's2a'),
    leaf('p2b', [surface('s2b', 'pty-2b', { surfaceType: 'browser' })]),
  ]),
  'p2a',
  { agentName: 'Codex', agentStatus: 'running' },
);
// ws-3: an unspawned surface (ptyId === ''), no workspace metadata → idle.
const w3 = workspace('ws-3', 'gamma', leaf('p3', [surface('s3', '')]), 'p3');

const surfaceAgentStatus: Record<string, AgentStatus> = {
  'pty-1': 'awaiting_input',
  'pty-2b': 'complete',
};

// Hook-driven activity strings keyed per-ptyId. pty-2a is the ACTIVE surface of
// the multi-surface leaf p2a, so its activity must land on that card; pty-1 has
// one to prove activity coexists with an attention status.
const surfaceActivity: Record<string, string> = {
  'pty-1': '$ npm test',
  'pty-2a': '✎ fleet.ts',
};

function fixture() {
  return { workspaces: [w1, w2, w3], surfaceAgentStatus, surfaceActivity };
}

function byPane(panes: FleetPane[], paneId: string): FleetPane {
  const found = panes.find((p) => p.paneId === paneId);
  if (!found) throw new Error(`pane ${paneId} not in fleet`);
  return found;
}

// ─── selectFleetPanes ────────────────────────────────────────────────────────

describe('selectFleetPanes', () => {
  it('emits exactly one card per leaf across every workspace and branch', () => {
    const panes = selectFleetPanes(fixture());
    expect(panes.map((p) => p.paneId).sort()).toEqual(['p1', 'p2a', 'p2b', 'p3']);
  });

  it('walks deeply nested branch-of-branches (recursion regression)', () => {
    // A root branch holding an inner branch (two leaves) + a sibling leaf:
    // three leaves at depth 2/1. Exercises getLeafPanes recursion beyond the
    // depth-1 trees the shared fixture uses.
    const deep = workspace(
      'ws-deep', 'deep',
      branch('root', [
        branch('inner', [
          leaf('p4a', [surface('s4a', 'pty-4a')]),
          leaf('p4b', [surface('s4b', 'pty-4b')]),
        ]),
        leaf('p4c', [surface('s4c', 'pty-4c')]),
      ]),
      'p4a',
    );
    const panes = selectFleetPanes({ workspaces: [deep], surfaceAgentStatus: {}, surfaceActivity: {} });
    expect(panes.map((p) => p.paneId).sort()).toEqual(['p4a', 'p4b', 'p4c']);
  });

  it('surfaces attention from a NON-active surface of a multi-tab leaf', () => {
    // The active tab is quiet but a background tab is awaiting_input — the card
    // must reflect the urgent state, not silently show idle.
    const tabbed = leaf('p', [surface('active', 'pty-active'), surface('bg', 'pty-bg')], 'active');
    const ws = workspace('w', 'w', tabbed, 'p');
    const [card] = selectFleetPanes({ workspaces: [ws], surfaceAgentStatus: { 'pty-bg': 'awaiting_input' }, surfaceActivity: {} });
    expect(card.agentStatus).toBe('awaiting_input'); // from the background tab
    expect(card.ptyId).toBe('pty-active');           // card stays keyed on active surface
  });

  it('picks the most-urgent attention status across a leaf\'s surfaces', () => {
    const tabbed = leaf('p', [surface('a', 'pa'), surface('b', 'pb'), surface('c', 'pc')], 'a');
    const ws = workspace('w', 'w', tabbed, 'p');
    const [card] = selectFleetPanes({
      workspaces: [ws],
      surfaceAgentStatus: { pb: 'complete', pc: 'awaiting_input' },
      surfaceActivity: {},
    });
    expect(card.agentStatus).toBe('awaiting_input'); // rank 0 beats complete (rank 3)
  });

  it('picks the active surface of a multi-surface leaf, not surfaces[0]', () => {
    const p2a = byPane(selectFleetPanes(fixture()), 'p2a');
    expect(p2a.surfaceId).toBe('s2a');
    expect(p2a.ptyId).toBe('pty-2a');
  });

  it('per-pty attention status wins over workspace-level metadata', () => {
    // pty-1 is awaiting_input in surfaceAgentStatus; ws-1 metadata says running.
    const p1 = byPane(selectFleetPanes(fixture()), 'p1');
    expect(p1.agentStatus).toBe('awaiting_input');
  });

  it('falls back to workspace metadata.agentStatus only for the active pane', () => {
    // p2a is active, has no per-pty entry → inherits ws-2 metadata 'running'.
    const p2a = byPane(selectFleetPanes(fixture()), 'p2a');
    expect(p2a.agentStatus).toBe('running');
    expect(p2a.isActivePane).toBe(true);
  });

  it('keeps per-pty attention status for a BACKGROUND pane but not its agentName', () => {
    const p2b = byPane(selectFleetPanes(fixture()), 'p2b');
    expect(p2b.agentStatus).toBe('complete'); // per-pty, accurate in background
    expect(p2b.isActivePane).toBe(false);
    expect(p2b.agentName).toBeUndefined();     // workspace name not borrowed
    expect(p2b.surfaceType).toBe('browser');
  });

  it('defaults to idle for an unspawned surface (ptyId === "") with no metadata', () => {
    const p3 = byPane(selectFleetPanes(fixture()), 'p3');
    expect(p3.agentStatus).toBe('idle');
    expect(p3.ptyId).toBe('');
    expect(p3.surfaceType).toBe('terminal');
  });

  it('exposes agentName only for the active pane', () => {
    const panes = selectFleetPanes(fixture());
    expect(byPane(panes, 'p1').agentName).toBe('Claude Code');
    expect(byPane(panes, 'p2a').agentName).toBe('Codex');
    expect(byPane(panes, 'p3').agentName).toBeUndefined();
  });

  it('carries workspace identity + cwd for the jump + context line', () => {
    const p2b = byPane(selectFleetPanes(fixture()), 'p2b');
    expect(p2b.workspaceId).toBe('ws-2');
    expect(p2b.workspaceName).toBe('beta');
    expect(p2b.cwd).toBe('C:\\repo\\s2b');
  });

  // ─── Hook-driven activity line (fleet-activity-line-hook) ──────────────────

  it('threads the per-ptyId activity string onto the card', () => {
    const p1 = byPane(selectFleetPanes(fixture()), 'p1');
    expect(p1.activity).toBe('$ npm test'); // surfaceActivity['pty-1']
  });

  it('keys activity on the ACTIVE surface of a multi-surface leaf (not surfaces[0])', () => {
    // p2a's active surface is pty-2a; surfaceActivity has pty-2a → "✎ fleet.ts".
    // The non-active first surface (pty-2a-first) has no entry, so picking the
    // wrong surface would yield undefined.
    const p2a = byPane(selectFleetPanes(fixture()), 'p2a');
    expect(p2a.ptyId).toBe('pty-2a');
    expect(p2a.activity).toBe('✎ fleet.ts');
  });

  it('leaves activity undefined when the pty has no entry (no-hook fallback path)', () => {
    // p2b (browser, pty-2b) and p3 (unspawned, ptyId '') have no activity entry.
    const panes = selectFleetPanes(fixture());
    expect(byPane(panes, 'p2b').activity).toBeUndefined();
    expect(byPane(panes, 'p3').activity).toBeUndefined();
  });

  it('never reads activity for an unspawned surface (empty ptyId)', () => {
    // Even if a stray '' key existed in the map, the selector must not surface
    // it onto an unspawned card.
    const ws = workspace('w', 'w', leaf('p', [surface('s', '')]), 'p');
    const [card] = selectFleetPanes({
      workspaces: [ws],
      surfaceAgentStatus: {},
      surfaceActivity: { '': 'should-never-show' },
    });
    expect(card.activity).toBeUndefined();
  });
});

// ─── sortFleetPanes ──────────────────────────────────────────────────────────

describe('sortFleetPanes', () => {
  it('floats awaiting_input to the top and sinks idle (attention-first)', () => {
    const sorted = sortFleetPanes(selectFleetPanes(fixture()));
    // ranks: awaiting_input(p1)=0, complete(p2b)=3, running(p2a)=4, idle(p3)=5
    expect(sorted.map((p) => p.paneId)).toEqual(['p1', 'p2b', 'p2a', 'p3']);
  });

  it('breaks ties by workspace name, then title', () => {
    const base: FleetPane = { workspaceId: 'w', workspaceName: '', paneId: '', surfaceId: 's', ptyId: 'p', agentStatus: 'running', title: '', surfaceType: 'terminal', isActivePane: false };
    // same status → workspace name decides (alpha < zeta)
    const a = { ...base, paneId: 'a', workspaceName: 'zeta', title: 'a' };
    const b = { ...base, paneId: 'b', workspaceName: 'alpha', title: 'b' };
    expect(sortFleetPanes([a, b]).map((p) => p.paneId)).toEqual(['b', 'a']);
    // same status + same workspace → title decides (aaa < zzz)
    const c = { ...base, paneId: 'c', workspaceName: 'alpha', title: 'zzz' };
    const d = { ...base, paneId: 'd', workspaceName: 'alpha', title: 'aaa' };
    expect(sortFleetPanes([c, d]).map((p) => p.paneId)).toEqual(['d', 'c']);
  });

  it('preserves input order for fully-equal entries (stable sort)', () => {
    const base: FleetPane = { workspaceId: 'w', workspaceName: 'w', paneId: '', surfaceId: 's', ptyId: 'p', agentStatus: 'running', title: 't', surfaceType: 'terminal', isActivePane: false };
    const x = { ...base, paneId: 'x' };
    const y = { ...base, paneId: 'y' };
    const z = { ...base, paneId: 'z' };
    expect(sortFleetPanes([x, y, z]).map((p) => p.paneId)).toEqual(['x', 'y', 'z']);
  });

  it('does not mutate its input', () => {
    const input = selectFleetPanes(fixture());
    const before = input.map((p) => p.paneId);
    sortFleetPanes(input);
    expect(input.map((p) => p.paneId)).toEqual(before);
  });
});

// ─── countNeedsAttention ─────────────────────────────────────────────────────

describe('countNeedsAttention', () => {
  it('counts awaiting_input and waiting, ignores everything else', () => {
    const panes = selectFleetPanes(fixture());
    expect(countNeedsAttention(panes)).toBe(1); // only p1 (awaiting_input)
  });

  it('counts both awaiting_input and waiting states', () => {
    const base: FleetPane = { workspaceId: 'w', workspaceName: 'w', paneId: 'x', surfaceId: 'x', ptyId: 'x', agentStatus: 'idle', title: 'x', surfaceType: 'terminal', isActivePane: false };
    const panes: FleetPane[] = [
      { ...base, paneId: '1', agentStatus: 'awaiting_input' },
      { ...base, paneId: '2', agentStatus: 'waiting' },
      { ...base, paneId: '3', agentStatus: 'running' },
      { ...base, paneId: '4', agentStatus: 'complete' },
    ];
    expect(countNeedsAttention(panes)).toBe(2);
  });
});
