import { describe, it, expect } from 'vitest';
import { buildPhoneSidebarSnapshot, phoneHandoffTitle } from '../phoneSidebarSnapshot';
import { resolveTaskLink } from '../../utils/fanoutProvenance';
import { parsePhoneSidebarSnapshot, PHONE_SIDEBAR_LIMITS } from '../../../shared/phoneFleetSidebar';
import type { StoreState } from '../../stores';
import type { Workspace, Pane, PaneLeaf, Surface, AgentStatus } from '../../../shared/types';
import type { WorkTask } from '../../../shared/workTask';
import type { FanoutOrigin } from '../../../shared/fanoutOrigin';
import type { MoaPendingDecision, MoaState } from '../../../shared/moa';
import type { WorkLink } from '../../../shared/workLink';

const NOW = 5_000_000;

function surface(id: string, ptyId: string, extra: Partial<Surface> = {}): Surface {
  return { id, ptyId, title: id, shell: 'zsh', cwd: `/repo/${id}`, surfaceType: 'terminal', ...extra };
}
function leaf(id: string, surfaces: Surface[], ordinal?: number): Pane {
  return { id, type: 'leaf', surfaces, activeSurfaceId: surfaces[0].id, ...(ordinal !== undefined ? { ordinal } : {}) } as Pane;
}
function workspace(id: string, panes: Pane[], extra: Partial<Workspace> = {}): Workspace {
  const rootPane: Pane = panes.length === 1 ? panes[0] : { id: `root-${id}`, type: 'branch', direction: 'horizontal', children: panes };
  return { id, name: id, rootPane, activePaneId: panes[0].id, ...extra };
}
function mission(id: string, owner: string, extra: Partial<WorkTask> = {}): WorkTask {
  return {
    id,
    title: `Task ${id}`,
    status: 'open',
    missionChannelId: `ch-${id}`,
    createdAt: 1_700_000_000_000,
    createdBy: { principalId: owner, verifiedWorkspaceId: owner },
    owner: { principalId: owner, verifiedWorkspaceId: owner },
    branch: `wmux/${id}`,
    worktreePath: `/wt/${id}`,
    ...extra,
  } as WorkTask;
}

function state(opts: {
  workspaces: Workspace[];
  missions?: Record<string, WorkTask>;
  lineage?: Record<string, string>;
  spawnOwner?: Record<string, string>;
  provenance?: Record<string, { ownerWorkspaceId: string; callerIdentity: 'gui'; at: number }>;
  status?: Record<string, AgentStatus>;
  pinned?: string[];
  paneLabel?: Record<string, string>;
  activeWorkspaceId?: string;
  origin?: Record<string, FanoutOrigin>;
}): StoreState {
  const surfaceAgent: Record<string, { name: string; status: AgentStatus }> = {};
  const surfaceAgentStatus: Record<string, AgentStatus> = {};
  for (const [pty, st] of Object.entries(opts.status ?? {})) {
    surfaceAgent[pty] = { name: 'Claude Code', status: st };
    if (st !== 'idle' && st !== 'running') surfaceAgentStatus[pty] = st;
  }
  return {
    workspaces: opts.workspaces,
    activeWorkspaceId: opts.activeWorkspaceId ?? opts.workspaces[0]?.id ?? '',
    missionByPaneGroup: opts.missions ?? {},
    fanoutLineage: opts.lineage ?? {},
    fanoutSpawnOwner: opts.spawnOwner ?? {},
    fanoutProvenance: opts.provenance ?? {},
    fanoutOrigin: opts.origin ?? {},
    sidebarPinnedIds: opts.pinned ?? [],
    surfaceAgent,
    surfaceAgentStatus,
    surfacePendingQuestion: {},
    surfaceQuestionSeen: {},
    surfaceActivity: {},
    surfaceActivityAt: {},
    surfaceTurnOpenAt: {},
    paneLabel: opts.paneLabel ?? {},
    agentClockMs: NOW,
    remoteWorkspaces: [],
  } as unknown as StoreState;
}

describe('buildPhoneSidebarSnapshot — workspace rows', () => {
  it('projects manual order, pin, color and the git badge fields', () => {
    const a = workspace('a', [leaf('pa', [surface('sa', 'pty-a')])], {
      color: 'teal',
      metadata: { gitBranch: 'feat/x', gitIsWorktree: true, gitSync: { dirty: 3, ahead: 2, behind: 1, hasUpstream: true } },
    });
    const b = workspace('b', [leaf('pb', [surface('sb', 'pty-b')])]);
    const snap = buildPhoneSidebarSnapshot(state({ workspaces: [a, b], pinned: ['b'], activeWorkspaceId: 'b' }));
    expect(snap.activeWorkspaceId).toBe('b');
    const single = (paneId: string, ptyId: string) => ({
      // The fixture names a pane `p<x>` and its tab `s<x>`.
      root: { kind: 'leaf', paneId, surfaces: [{ surfaceId: `s${paneId.slice(1)}`, kind: 'terminal', ptyId }], activeIndex: 0 },
      activePaneId: paneId,
    });
    expect(snap.workspaces).toEqual([
      { id: 'a', order: 0, pinned: false, color: 'teal', gitBranch: 'feat/x', gitIsWorktree: true, gitSync: { ahead: 2, behind: 1, hasUpstream: true }, layout: single('pa', 'pty-a') },
      { id: 'b', order: 1, pinned: true, layout: single('pb', 'pty-b') },
    ]);
  });

  it('omits a null git sync and leaves no key for an absent color', () => {
    const a = workspace('a', [leaf('pa', [surface('sa', 'pty-a')])], { metadata: { gitSync: null } });
    const [row] = buildPhoneSidebarSnapshot(state({ workspaces: [a] })).workspaces;
    expect(row).toEqual({ id: 'a', order: 0, pinned: false, layout: expect.anything() });
  });

  it('reports the same task link resolveTaskLink gives the sidebar, for every evidence source', () => {
    const owner = workspace('owner', [leaf('po', [surface('so', 'pty-o')])]);
    const t1 = workspace('t1', [leaf('p1', [surface('s1', 'pty-1')])]);
    const t2 = workspace('t2', [leaf('p2', [surface('s2', 'pty-2')])]);
    const t3 = workspace('t3', [leaf('p3', [surface('s3', 'pty-3')])]);
    const t4 = workspace('t4', [leaf('p4', [surface('s4', 'pty-4')])]);
    const plain = workspace('plain', [leaf('pp', [surface('sp', 'pty-p')])]);
    const missions = {
      t1: mission('task-1', 'owner'),
      t2: mission('task-2', 'owner', { detachedAt: 9 }),
      t4: mission('task-4', '', { owner: undefined } as unknown as Partial<WorkTask>),
    };
    const lineage = { t3: 'owner' };
    const provenance = { t1: { ownerWorkspaceId: 'owner', callerIdentity: 'gui' as const, at: 1_800_000_000_000 } };
    const s = state({ workspaces: [owner, t1, t2, t3, t4, plain], missions, lineage, provenance });
    const snap = buildPhoneSidebarSnapshot(s);
    const byId = new Map(snap.workspaces.map((w) => [w.id, w]));
    for (const id of ['owner', 't1', 't2', 't3', 't4', 'plain']) {
      const link = resolveTaskLink(s.missionByPaneGroup[id], s.fanoutLineage[id], s.fanoutSpawnOwner[id]);
      const row = byId.get(id)!;
      if (!link) expect(row.task).toBeUndefined();
      else {
        expect(row.task?.ownerWorkspaceId).toBe(link.ownerId || null);
        expect(row.task?.detached).toBe(link.detached);
      }
    }
    // Audit time wins over the record's creation time; a lineage-only task has neither.
    expect(byId.get('t1')!.task).toMatchObject({ ownerWorkspaceId: 'owner', detached: false, createdAt: 1_800_000_000_000, nested: true });
    expect(byId.get('t2')!.task).toEqual({ ownerWorkspaceId: 'owner', detached: true, createdAt: 1_700_000_000_000, nested: false });
    expect(byId.get('t3')!.task).toMatchObject({ ownerWorkspaceId: 'owner', detached: false, nested: true });
    expect(byId.get('t3')!.task).not.toHaveProperty('createdAt');
    expect(byId.get('t4')!.task).toEqual({ ownerWorkspaceId: null, detached: false, createdAt: 1_700_000_000_000, nested: false });
  });

  it('marks nested exactly where buildSidebarTree nests, with the rollup bits on nested tasks only', () => {
    const owner = workspace('owner', [leaf('po', [surface('so', 'pty-o')])]);
    const waiting = workspace('t1', [leaf('p1', [surface('s1', 'pty-1')])]);
    const done = workspace('t2', [leaf('p2', [surface('s2', 'pty-2')])]);
    const detached = workspace('t3', [leaf('p3', [surface('s3', 'pty-3')])]);
    const orphan = workspace('t4', [leaf('p4', [surface('s4', 'pty-4')])]);
    const snap = buildPhoneSidebarSnapshot(state({
      workspaces: [owner, waiting, done, detached, orphan],
      missions: {
        t1: mission('task-1', 'owner'),
        t2: mission('task-2', 'owner'),
        t3: mission('task-3', 'owner', { detachedAt: 5 }),
        t4: mission('task-4', 'closed-owner'),
      },
      status: { 'pty-1': 'awaiting_input', 'pty-2': 'complete', 'pty-3': 'complete', 'pty-4': 'complete' },
    }));
    const byId = new Map(snap.workspaces.map((w) => [w.id, w]));
    expect(byId.get('owner')!.task).toBeUndefined();
    expect(byId.get('t1')!.task).toMatchObject({ nested: true, state: { needYou: true, toReview: false, finished: false } });
    expect(byId.get('t2')!.task).toMatchObject({ nested: true, state: { needYou: false, toReview: true, finished: true } });
    // Detached: an ordinary row again. Owner closed: the "From closed workspace" group.
    for (const id of ['t3', 't4']) {
      expect(byId.get(id)!.task?.nested).toBe(false);
      expect(byId.get(id)!.task).not.toHaveProperty('state');
    }
  });

  it('draws a task whose owner is itself a nested task top-level (depth 1 only)', () => {
    const grand = workspace('grand', [leaf('pg', [surface('sg', 'pty-g')])]);
    const mid = workspace('mid', [leaf('pm', [surface('sm', 'pty-m')])]);
    const leafTask = workspace('leafTask', [leaf('pl', [surface('sl', 'pty-l')])]);
    const snap = buildPhoneSidebarSnapshot(state({
      workspaces: [grand, mid, leafTask],
      missions: { mid: mission('task-m', 'grand'), leafTask: mission('task-l', 'mid') },
    }));
    const byId = new Map(snap.workspaces.map((w) => [w.id, w]));
    expect(byId.get('mid')!.task).toMatchObject({ ownerWorkspaceId: 'grand', nested: true });
    expect(byId.get('leafTask')!.task).toMatchObject({ ownerWorkspaceId: 'mid', nested: false });
  });
});

describe('buildPhoneSidebarSnapshot — tasks under the requesting pane (#1581 split)', () => {
  const paneOrigin = (paneId: string, surfaceId: string): FanoutOrigin => ({ kind: 'pane', paneId, surfaceId, label: 'secret label' });

  it('files each nested task like splitTasksByPane: live pane, stashed pane, closed pane, unknown origin', () => {
    const owner = workspace('owner', [
      leaf('pa', [surface('sa', 'pty-a')]),
      leaf('pb', [surface('sb', 'pty-b')]),
    ], { stashedPanes: [{ pane: leaf('pst', [surface('sst', 'pty-st')]), stashedAt: 1 }] } as Partial<Workspace>);
    const tasks = ['t1', 't2', 't3', 't4', 't5', 't6'].map((id) => workspace(id, [leaf(`p-${id}`, [surface(`s-${id}`, `pty-${id}`)])]));
    const missions = Object.fromEntries(['t1', 't2', 't3', 't4', 't5'].map((id) => [id, mission(`task-${id}`, 'owner')]));
    missions.t6 = mission('task-t6', 'owner', { detachedAt: 5 });
    const snap = buildPhoneSidebarSnapshot(state({
      workspaces: [owner, ...tasks],
      missions,
      origin: {
        t1: paneOrigin('pa', 'sa'),
        t2: paneOrigin('pb', 'sb'),
        t3: paneOrigin('pst', 'sst'),
        t4: paneOrigin('gone-pane', 'gone-surface'),
        // t5: no origin at all (orchestrator / GUI / older stamp)
        t6: paneOrigin('pa', 'sa'),
      },
    }));
    const byId = new Map(snap.workspaces.map((w) => [w.id, w]));
    expect(byId.get('t1')!.task).toMatchObject({ nested: true, paneGroup: 'pane', requesterPaneId: 'pa' });
    expect(byId.get('t2')!.task).toMatchObject({ nested: true, paneGroup: 'pane', requesterPaneId: 'pb' });
    expect(byId.get('t3')!.task).toMatchObject({ nested: true, paneGroup: 'pane', requesterPaneId: 'pst' });
    for (const id of ['t4', 't5']) {
      expect(byId.get(id)!.task).toMatchObject({ nested: true, paneGroup: 'closedPane' });
      expect(byId.get(id)!.task).not.toHaveProperty('requesterPaneId');
    }
    // Detached: not nested, no placement at all.
    expect(byId.get('t6')!.task).toMatchObject({ nested: false });
    expect(byId.get('t6')!.task).not.toHaveProperty('paneGroup');
    expect(byId.get('t6')!.task).not.toHaveProperty('requesterPaneId');
    // The origin's label never leaves; the placement survives the allowlist.
    expect(JSON.stringify(snap)).not.toContain('secret label');
    expect(parsePhoneSidebarSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
  });

  it('follows the requesting surface when it moves to another pane, and gives an orphan no placement', () => {
    const tasks = [workspace('t1', [leaf('p-t1', [surface('s-t1', 'pty-t1')])]), workspace('t2', [leaf('p-t2', [surface('s-t2', 'pty-t2')])])];
    const missions = { t1: mission('task-1', 'owner'), t2: mission('task-2', 'closed-owner') };
    const origin = { t1: paneOrigin('pa', 'sa'), t2: paneOrigin('pa', 'sa') };
    const before = buildPhoneSidebarSnapshot(state({
      workspaces: [workspace('owner', [leaf('pa', [surface('sa', 'pty-a')]), leaf('pb', [surface('sb', 'pty-b')])]), ...tasks],
      missions, origin,
    }));
    expect(before.workspaces.find((w) => w.id === 't1')!.task).toMatchObject({ paneGroup: 'pane', requesterPaneId: 'pa' });
    const after = buildPhoneSidebarSnapshot(state({
      workspaces: [workspace('owner', [leaf('pb', [surface('sb', 'pty-b'), surface('sa', 'pty-a')])]), ...tasks],
      missions, origin,
    }));
    expect(after.workspaces.find((w) => w.id === 't1')!.task).toMatchObject({ paneGroup: 'pane', requesterPaneId: 'pb' });
    // Owner gone: "From closed workspace", no pane placement.
    expect(after.workspaces.find((w) => w.id === 't2')!.task).toEqual(expect.objectContaining({ nested: false }));
    expect(after.workspaces.find((w) => w.id === 't2')!.task).not.toHaveProperty('paneGroup');
  });
});

describe('buildPhoneSidebarSnapshot — pane rows', () => {
  it('names panes like the roster: label, else the coordinate; agent titles drop a bare shell name', () => {
    const ws = workspace('a', [
      leaf('p1', [surface('s1', 'pty-1', { title: '✳ app review' })], 5),
      leaf('p2', [surface('s2', 'pty-2', { title: 'zsh' })], 6),
      leaf('p3', [surface('s3', 'pty-3', { title: 'zsh' })], 7),
    ], { wsOrdinal: 123 });
    const snap = buildPhoneSidebarSnapshot(state({
      workspaces: [ws],
      status: { 'pty-1': 'running', 'pty-2': 'idle' },
      paneLabel: { p3: 'builds' },
    }));
    expect(snap.panes).toEqual([
      { ptyId: 'pty-1', workspaceId: 'a', paneId: 'p1', surfaceTitle: '✳ app review', paneName: 'w123-5' },
      { ptyId: 'pty-2', workspaceId: 'a', paneId: 'p2', paneName: 'w123-6' },
      { ptyId: 'pty-3', workspaceId: 'a', paneId: 'p3', surfaceTitle: 'zsh', paneName: 'builds' },
    ]);
  });

  it('never emits a brain pty, a remote mirror or a browser surface; includes stashed panes', () => {
    const ws = workspace('a', [
      leaf('p1', [
        surface('s1', 'brain-xyz', { title: 'orchestrator' }),
        surface('s2', '', { surfaceType: 'remote-terminal', title: 'remote' } as Partial<Surface>),
        surface('s3', 'pty-b', { surfaceType: 'browser', title: 'web' } as Partial<Surface>),
      ], 1),
    ], {
      wsOrdinal: 2,
      stashedPanes: [{ pane: leaf('p9', [surface('s9', 'pty-stashed', { title: 'parked' })], 9), stashedAt: 1 }],
    } as Partial<Workspace>);
    const snap = buildPhoneSidebarSnapshot(state({ workspaces: [ws] }));
    expect(snap.panes).toEqual([{ ptyId: 'pty-stashed', workspaceId: 'a', paneId: 'p9', surfaceTitle: 'parked', paneName: 'w2-9' }]);
    expect(JSON.stringify(snap)).not.toContain('brain-');
  });

  it('bounds titles and survives its own allowlist unchanged', () => {
    const long = 'x'.repeat(PHONE_SIDEBAR_LIMITS.surfaceTitle + 50);
    const ws = workspace('a', [leaf('p1', [surface('s1', 'pty-1', { title: long })], 1)], { wsOrdinal: 1, color: 'blue' });
    const snap = buildPhoneSidebarSnapshot(state({ workspaces: [ws] }));
    expect(snap.panes[0].surfaceTitle).toHaveLength(PHONE_SIDEBAR_LIMITS.surfaceTitle);
    expect(parsePhoneSidebarSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
  });
});

describe('buildPhoneSidebarSnapshot — one bad part never costs the snapshot', () => {
  it('leaves out only the task that throws, and only the pane that throws, and reports why', () => {
    const owner = workspace('owner', [leaf('po', [surface('so', 'pty-o')], 1)], { wsOrdinal: 1, metadata: { gitBranch: 'main' } });
    const task = workspace('t1', [leaf('p1', [surface('s1', 'pty-1')], 1)], { wsOrdinal: 2, metadata: { gitBranch: 'wtask/x' } });
    const other = workspace('other', [leaf('px', [surface('sx', 'pty-x')], 1)], { wsOrdinal: 3 });
    // A task record whose owner cannot be read, and a leaf whose surfaces cannot be.
    const poisoned = new Proxy({} as WorkTask, { get: () => { throw new Error('corrupt record'); } });
    const badLeaf = leaf('pbad', [surface('sbad', 'pty-bad')], 2);
    Object.defineProperty(badLeaf, 'surfaces', { get: () => { throw new Error('corrupt leaf'); } });
    other.rootPane = { id: 'root-other', type: 'branch', direction: 'horizontal', children: [leaf('px', [surface('sx', 'pty-x')], 1), badLeaf] } as Pane;
    const reasons: string[] = [];
    const snap = buildPhoneSidebarSnapshot(state({ workspaces: [owner, task, other], missions: { t1: poisoned } }), (r) => reasons.push(r));
    expect(snap.workspaces.map((w) => w.id)).toEqual(['owner', 't1', 'other']);
    expect(snap.workspaces[1]).toEqual({ id: 't1', order: 1, pinned: false, gitBranch: 'wtask/x', layout: expect.anything() });
    expect(snap.workspaces[0]).toMatchObject({ gitBranch: 'main' });
    // The unreadable leaf costs its workspace's tree, never the row.
    expect(snap.workspaces[2]).toEqual({ id: 'other', order: 2, pinned: false });
    expect(snap.panes.map((p) => p.ptyId)).toEqual(['pty-o', 'pty-1', 'pty-x']);
    expect(reasons).toEqual(expect.arrayContaining(['task.tree', 'workspace.task', 'pane.row', 'workspace.layout']));
    expect(reasons.join(' ')).not.toContain('corrupt');
  });
});

describe('buildPhoneSidebarSnapshot — layout tree', () => {
  const layoutOf = (ws: Workspace, reasons?: string[]) => {
    const snap = buildPhoneSidebarSnapshot(state({ workspaces: [ws] }), (r) => reasons?.push(r));
    return { snap, layout: snap.workspaces[0].layout };
  };

  it('mirrors rootPane: direction, sizes, tab order, active tab (a browser tab) and focused pane; stashed panes stay out', () => {
    const tabs = { ...(leaf('pa', [
      surface('s1', 'pty-1'),
      surface('s2', 'pty-2'),
      surface('s3', '', { surfaceType: 'browser', title: 'Docs ‮home' } as Partial<Surface>),
    ]) as PaneLeaf), activeSurfaceId: 's3' };
    const ws: Workspace = {
      id: 'a', name: 'a', activePaneId: 'pc',
      rootPane: {
        id: 'r', type: 'branch', direction: 'horizontal', sizes: [70, 30], children: [
          tabs,
          // No sizes on the inner split: the desktop renders it equal.
          { id: 'r2', type: 'branch', direction: 'vertical', children: [leaf('pb', [surface('sb', 'pty-b')]), leaf('pc', [surface('sc', 'brain-1')])] },
        ],
      },
      stashedPanes: [{ pane: leaf('pst', [surface('sst', 'pty-st')]) as PaneLeaf, stashedAt: 1 }],
    } as Workspace;
    const { snap, layout } = layoutOf(ws);
    expect(layout).toEqual({
      root: {
        kind: 'split', direction: 'horizontal', sizes: [70, 30], children: [
          { kind: 'leaf', paneId: 'pa', activeIndex: 2, surfaces: [
            { surfaceId: 's1', kind: 'terminal', ptyId: 'pty-1' },
            { surfaceId: 's2', kind: 'terminal', ptyId: 'pty-2' },
            { surfaceId: 's3', kind: 'browser', title: 'Docs home' },
          ] },
          { kind: 'split', direction: 'vertical', sizes: [50, 50], children: [
            { kind: 'leaf', paneId: 'pb', surfaces: [{ surfaceId: 'sb', kind: 'terminal', ptyId: 'pty-b' }], activeIndex: 0 },
            // The brain session keeps its tab slot but never its id.
            { kind: 'leaf', paneId: 'pc', surfaces: [{ surfaceId: 'sc', kind: 'terminal' }], activeIndex: 0 },
          ] },
        ],
      },
      activePaneId: 'pc',
    });
    // Whatever the renderer builds, the parsers accept unchanged.
    expect(parsePhoneSidebarSnapshot(JSON.parse(JSON.stringify(snap)))?.workspaces[0].layout).toEqual(layout);
  });

  it('projects a browser-only leaf, a remote mirror and an unknown surface type', () => {
    const ws = workspace('a', [leaf('pa', [
      surface('s1', '', { surfaceType: 'browser', title: 'Search' } as Partial<Surface>),
      surface('s2', '', { surfaceType: 'remote-terminal', title: 'build box' } as Partial<Surface>),
      surface('s3', '', { surfaceType: 'hologram', title: '' } as unknown as Partial<Surface>),
    ])]);
    expect(layoutOf(ws).layout?.root).toEqual({
      kind: 'leaf', paneId: 'pa', activeIndex: 0,
      surfaces: [{ surfaceId: 's1', kind: 'browser', title: 'Search' }, { surfaceId: 's2', kind: 'remote-terminal', title: 'build box' }, { surfaceId: 's3', kind: 'other' }],
    });
  });

  it('drops only a ptyId the parsers would refuse, keeping the tab slot and the tree', () => {
    const bad = [' pty-pad', 'pty-pad ', '__proto__', 'constructor', 'x'.repeat(129), 'pty‮evil', 'pty\u0007bell'];
    const ws = workspace('a', [leaf('pa', [surface('s0', 'pty-ok'), ...bad.map((ptyId, i) => surface(`s${i + 1}`, ptyId))])]);
    const reasons: string[] = [];
    const { snap, layout } = layoutOf(ws, reasons);
    expect(layout?.root).toEqual({
      kind: 'leaf', paneId: 'pa', activeIndex: 0,
      surfaces: [{ surfaceId: 's0', kind: 'terminal', ptyId: 'pty-ok' }, ...bad.map((_, i) => ({ surfaceId: `s${i + 1}`, kind: 'terminal' }))],
    });
    expect(reasons.filter((r) => r.startsWith('workspace.layout'))).toEqual([]);
    expect(parsePhoneSidebarSnapshot(JSON.parse(JSON.stringify(snap)))?.workspaces[0].layout).toEqual(layout);
  });

  it('projects no tree when a tab has no usable surface id (a reader keys tabs by it)', () => {
    const reasons: string[] = [];
    const dup = workspace('a', [leaf('pa', [surface('same', 'p1')]), leaf('pb', [surface('same', 'p2')])]);
    expect(layoutOf(dup, reasons).layout).toBeUndefined();
    expect(layoutOf(workspace('b', [leaf('pa', [surface('__proto__', 'p1')])])).layout).toBeUndefined();
    expect(reasons).toContain('workspace.layout.bounds');
  });

  it('normalises unequal sizes and falls back to an equal split for missing, mismatched or bad ones', () => {
    const three = [leaf('a', [surface('sa', 'p-a')]), leaf('b', [surface('sb', 'p-b')]), leaf('c', [surface('sc', 'p-c')])];
    const withSizes = (sizes: number[] | undefined) =>
      workspace('w', three, { rootPane: { id: 'r', type: 'branch', direction: 'vertical', children: three, ...(sizes ? { sizes } : {}) } });
    const sizesOf = (ws: Workspace) => { const root = layoutOf(ws).layout?.root; return root?.kind === 'split' ? root.sizes : null; };
    expect(sizesOf(withSizes([2, 1, 1]))).toEqual([50, 25, 25]);
    for (const bad of [undefined, [50, 50], [0, 50, 50], [NaN, 1, 1]]) expect(sizesOf(withSizes(bad))).toEqual([33.34, 33.33, 33.33]);
  });

  it('falls back to the first tab when the active surface is gone, and omits a focused pane that is stashed', () => {
    const ws = workspace('a', [{ ...(leaf('pa', [surface('s1', 'p1'), surface('s2', 'p2')]) as PaneLeaf), activeSurfaceId: 'gone' }], {
      activePaneId: 'pst',
      stashedPanes: [{ pane: leaf('pst', [surface('sst', 'pty-st')]) as PaneLeaf, stashedAt: 1 }],
    });
    const { layout } = layoutOf(ws);
    expect(layout?.root).toMatchObject({ kind: 'leaf', paneId: 'pa', activeIndex: 0 });
    expect(layout).not.toHaveProperty('activePaneId');
  });

  it('projects no tree over the leaf bound, keeping the row and every pane', () => {
    const leaves = Array.from({ length: PHONE_SIDEBAR_LIMITS.layout.leaves + 1 }, (_, i) => leaf(`p${i}`, [surface(`s${i}`, `pty-${i}`)]));
    const reasons: string[] = [];
    const { snap, layout } = layoutOf(workspace('a', leaves), reasons);
    expect(layout).toBeUndefined();
    expect(snap.panes).toHaveLength(leaves.length);
    expect(reasons).toContain('workspace.layout.bounds');
  });
});

describe('buildPhoneSidebarSnapshot — the Moa HQ', () => {
  const moa = (hqWorkspaceId: string | null, enabled: boolean, hqState: MoaState['hq']['state'] = 'ok'): MoaState => ({
    config: { enabled, onboarded: true, level: 2, maxTurnsPerHour: 30, bubbles: true, reduceMotion: false, defaultReason: null },
    hq: { workspaceId: hqWorkspaceId, state: hqState },
    archive: { unacked: 0, total: 0 },
  });
  const withMoa = (m: MoaState | null) => {
    const a = workspace('a', [leaf('pa', [surface('sa', 'pty-a')])]);
    const hq = workspace('hq', [leaf('ph', [surface('sh', 'pty-h')])]);
    return { ...state({ workspaces: [a, hq] }), moa: m } as StoreState;
  };

  it('names the HQ once, at the snapshot level, and changes nothing else', () => {
    const plain = buildPhoneSidebarSnapshot(withMoa(null));
    const snap = buildPhoneSidebarSnapshot(withMoa(moa('hq', true)));
    expect(snap.hqWorkspaceId).toBe('hq');
    expect(snap.moa).toBe(true);
    // toEqual reads an undefined key as absent: every other field is unchanged.
    expect({ ...snap, hqWorkspaceId: undefined, moa: undefined }).toEqual(plain);
    expect('hqWorkspaceId' in plain || 'moa' in plain).toBe(false);
    expect(parsePhoneSidebarSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
  });

  it('keeps naming the HQ while Moa is off, as the desktop keeps it out of its list, but says moa only when on and present', () => {
    const off = buildPhoneSidebarSnapshot(withMoa(moa('hq', false)));
    expect(off.hqWorkspaceId).toBe('hq');
    expect(off).not.toHaveProperty('moa');
    const missing = buildPhoneSidebarSnapshot(withMoa(moa('hq', true, 'hq-missing')));
    expect(missing.hqWorkspaceId).toBe('hq');
    expect(missing).not.toHaveProperty('moa');
    // Main says ok but the renderer holds no such workspace yet.
    const notLive = buildPhoneSidebarSnapshot(withMoa(moa('gone', true)));
    expect(notLive).not.toHaveProperty('moa');
    const unset = buildPhoneSidebarSnapshot(withMoa(moa(null, true, 'unset')));
    expect(unset).not.toHaveProperty('hqWorkspaceId');
    expect(unset).not.toHaveProperty('moa');
  });

  it('names the remembered HQ before main\'s first answer (no flash on the phone), without claiming moa', () => {
    const boot = buildPhoneSidebarSnapshot({ ...withMoa(null), moaHqSeed: 'hq' } as StoreState);
    expect(boot.hqWorkspaceId).toBe('hq');
    expect(boot).not.toHaveProperty('moa');
    // Main's answer wins once it arrives.
    const answered = buildPhoneSidebarSnapshot({ ...withMoa(moa(null, true, 'unset')), moaHqSeed: 'hq' } as StoreState);
    expect(answered).not.toHaveProperty('hqWorkspaceId');
  });
});

describe('buildPhoneSidebarSnapshot — pending Moa hand-off notice', () => {
  const ws = [workspace('a', [leaf('pa', [surface('sa', 'pty-a')])]), workspace('b', [leaf('pb', [surface('sb', 'pty-b')])])];
  const card = (workspaceId: string, extra: Partial<MoaPendingDecision> = {}, options = ['Hand off', 'Edit', 'Cancel']): MoaPendingDecision => ({
    workspaceId,
    decision: { id: `d-${workspaceId}`, question: 'Hand this off?', options, context: '', raisedAt: 1_700_000_000_000 },
    handoff: {
      body: '\n  Fix the login redirect\nthen run the tests\n' + 'x'.repeat(16_000),
      title: 'Fallback title', agentName: 'Claude Code', targetPaneId: 'pa', targetPtyId: 'pty-a', foldsNewlines: false, willQueue: false,
    },
    ...extra,
  });

  it('puts the notice on the target workspace row only while a hand-off card is pending, never the body', () => {
    const snap = buildPhoneSidebarSnapshot(state({ workspaces: ws }), undefined, [card('a')]);
    expect(snap.workspaces[0].moaHandoff).toEqual({ agentName: 'Claude Code', title: 'Fix the login redirect', raisedAt: 1_700_000_000_000 });
    expect(snap.workspaces[1]).not.toHaveProperty('moaHandoff');
    expect(JSON.stringify(snap)).not.toContain('then run the tests');
    expect(parsePhoneSidebarSnapshot(snap)).toEqual(snap);
  });

  it('omits it without decisions, for a plain decision, and for the could-not-deliver notice', () => {
    const plain: MoaPendingDecision = { ...card('a'), handoff: undefined };
    for (const decisions of [undefined, [], [plain], [card('a', {}, ['OK'])]]) {
      const snap = buildPhoneSidebarSnapshot(state({ workspaces: ws }), undefined, decisions);
      expect(snap.workspaces.some((row) => 'moaHandoff' in row)).toBe(false);
    }
  });

  it('sanitises the title: first non-blank line, control and bidi characters stripped, cut to 80', () => {
    expect(phoneHandoffTitle('\r\n\t \n\u202eDo\u0007it\u2028second', 'f')).toBe('Do it');
    expect(phoneHandoffTitle('y'.repeat(500), 'f')).toBe('y'.repeat(PHONE_SIDEBAR_LIMITS.moaHandoffTitle));
    expect(phoneHandoffTitle('   \n\n', 'Fallback\ttitle')).toBe('Fallback title');
    expect(phoneHandoffTitle(undefined, undefined)).toBeUndefined();
  });
});

describe('buildPhoneSidebarSnapshot — Moa delegations', () => {
  const T = 1_700_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;
  const ws = [
    workspace('a', [leaf('pa', [surface('sa', 'pty-a')])]),
    workspace('b', [leaf('pb', [surface('sb', 'pty-b')])]),
  ];
  const link = (id: string, extra: Partial<WorkLink> = {}): WorkLink => ({
    id: `wl-${id}`,
    origin: 'moa',
    title: `Job ${id}`,
    a2aTaskId: `task-${id}`,
    a2aState: 'working',
    owner: { workspaceId: 'a', paneId: 'pa' },
    agent: 'codex',
    state: 'running',
    decisionIds: [],
    createdAt: T,
    updatedAt: T,
    ...extra,
  });
  const decision = (id: string, workspaceId = 'a'): MoaPendingDecision => ({
    workspaceId,
    decision: { id, question: 'Which branch?', options: ['main', 'dev'], context: '', raisedAt: T },
  });
  const build = (links: WorkLink[], opts: { decisions?: MoaPendingDecision[]; status?: Record<string, AgentStatus>; now?: number } = {}) =>
    buildPhoneSidebarSnapshot(state({ workspaces: ws, status: opts.status }), undefined, opts.decisions ?? [], { links, now: opts.now ?? T + 1000 });

  it("lists Moa-origin jobs with an A2A task only, named by the pane's agent, never the request or result", () => {
    const snap = build([
      link('1', { result: { summary: 'secret report', at: T } as WorkLink['result'] }),
      link('manual', { origin: 'manual' }),
      link('undelivered', { a2aTaskId: undefined }),
      link('auto', { origin: 'moa-auto', owner: { workspaceId: 'b' }, agent: undefined, updatedAt: T - 5 }),
    ], { status: { 'pty-a': 'running' } });
    expect(snap.moaDelegations).toEqual([
      { taskId: 'task-1', workspaceId: 'a', agentName: 'Claude Code', title: 'Job 1', state: 'working', since: T },
      { taskId: 'task-auto', workspaceId: 'b', agentName: 'Agent', title: 'Job auto', state: 'working', since: T - 5 },
    ]);
    expect(JSON.stringify(snap)).not.toContain('secret report');
    expect(parsePhoneSidebarSnapshot(snap)).toEqual(snap);
  });

  it('falls back to the link agent slug when the pane has no agent, and bounds the title', () => {
    const snap = build([link('1', { title: '\u202eFix\nit ' + 'y'.repeat(200) })]);
    expect(snap.moaDelegations?.[0].agentName).toBe('Codex CLI');
    expect(snap.moaDelegations?.[0].title).toBe(('Fix it ' + 'y'.repeat(200)).slice(0, PHONE_SIDEBAR_LIMITS.moaDelegationTitle));
  });

  it('is blocked while a linked Moa decision is pending, and working again once it is answered', () => {
    const pending = build([link('1', { decisionIds: ['d1'] })], { decisions: [decision('d1')] });
    expect(pending.moaDelegations?.[0].state).toBe('blocked');
    const answered = build([link('1', { decisionIds: ['d1'] })], { decisions: [] });
    expect(answered.moaDelegations?.[0].state).toBe('working');
  });

  it("is blocked while the delegated pane waits on a prompt, and not for another workspace's prompt", () => {
    expect(build([link('1')], { status: { 'pty-a': 'awaiting_input' } }).moaDelegations?.[0].state).toBe('blocked');
    expect(build([link('1')], { status: { 'pty-b': 'awaiting_input' } }).moaDelegations?.[0].state).toBe('working');
    // No pane named: the workspace's only agent pane stands in.
    expect(build([link('1', { owner: { workspaceId: 'a' } })], { status: { 'pty-a': 'awaiting_input' } }).moaDelegations?.[0].state).toBe('blocked');
  });

  it('keeps finished jobs for 24 h only, and keeps open ones however old', () => {
    const now = T + DAY + 10;
    const snap = build([
      link('old-done', { a2aState: 'completed', state: 'done', updatedAt: T }),
      link('fresh-failed', { a2aState: 'failed', state: 'blocked', reason: 'task-failed', updatedAt: T + 20 }),
      link('old-open', { updatedAt: T - DAY }),
    ], { now });
    expect(snap.moaDelegations?.map((d) => [d.taskId, d.state])).toEqual([['task-fresh-failed', 'failed'], ['task-old-open', 'working']]);
  });

  it('orders newest first and caps the list', () => {
    const links = Array.from({ length: 30 }, (_, i) => link(String(i), { updatedAt: T + i }));
    const list = build(links, { now: T + 100 }).moaDelegations ?? [];
    expect(list).toHaveLength(PHONE_SIDEBAR_LIMITS.moaDelegations);
    expect(list[0].taskId).toBe('task-29');
    expect(list.every((d, i) => i === 0 || list[i - 1].since >= d.since)).toBe(true);
  });

  it('is empty with no jobs, and absent when the links or the decisions could not be read', () => {
    expect(build([]).moaDelegations).toEqual([]);
    expect(buildPhoneSidebarSnapshot(state({ workspaces: ws }), undefined, [])).not.toHaveProperty('moaDelegations');
    expect(buildPhoneSidebarSnapshot(state({ workspaces: ws }), undefined, undefined, { links: [link('1')], now: T })).not.toHaveProperty('moaDelegations');
  });
});
