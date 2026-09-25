import { describe, it, expect } from 'vitest';
import { buildPhoneSidebarSnapshot } from '../phoneSidebarSnapshot';
import { resolveTaskLink } from '../../utils/fanoutProvenance';
import { parsePhoneSidebarSnapshot, PHONE_SIDEBAR_LIMITS } from '../../../shared/phoneFleetSidebar';
import type { StoreState } from '../../stores';
import type { Workspace, Pane, Surface, AgentStatus } from '../../../shared/types';
import type { WorkTask } from '../../../shared/workTask';

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
    expect(snap.workspaces).toEqual([
      { id: 'a', order: 0, pinned: false, color: 'teal', gitBranch: 'feat/x', gitIsWorktree: true, gitSync: { ahead: 2, behind: 1, hasUpstream: true } },
      { id: 'b', order: 1, pinned: true },
    ]);
  });

  it('omits a null git sync and leaves no key for an absent color', () => {
    const a = workspace('a', [leaf('pa', [surface('sa', 'pty-a')])], { metadata: { gitSync: null } });
    const [row] = buildPhoneSidebarSnapshot(state({ workspaces: [a] })).workspaces;
    expect(row).toEqual({ id: 'a', order: 0, pinned: false });
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
    expect(byId.get('t1')!.task).toEqual({ ownerWorkspaceId: 'owner', detached: false, createdAt: 1_800_000_000_000 });
    expect(byId.get('t2')!.task).toEqual({ ownerWorkspaceId: 'owner', detached: true, createdAt: 1_700_000_000_000 });
    expect(byId.get('t3')!.task).toEqual({ ownerWorkspaceId: 'owner', detached: false });
    expect(byId.get('t4')!.task?.ownerWorkspaceId).toBeNull();
  });

  it('summarises the owner row with the sidebar rollup (nested tasks only)', () => {
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
    expect(byId.get('owner')!.taskSummary).toEqual({ tasks: 2, needYou: 1, toReview: 1, finished: 1 });
    for (const id of ['t1', 't2', 't3', 't4']) expect(byId.get(id)!.taskSummary).toBeUndefined();
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
      { ptyId: 'pty-1', workspaceId: 'a', surfaceTitle: '✳ app review', paneName: 'w123-5' },
      { ptyId: 'pty-2', workspaceId: 'a', paneName: 'w123-6' },
      { ptyId: 'pty-3', workspaceId: 'a', surfaceTitle: 'zsh', paneName: 'builds' },
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
    expect(snap.panes).toEqual([{ ptyId: 'pty-stashed', workspaceId: 'a', surfaceTitle: 'parked', paneName: 'w2-9' }]);
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
