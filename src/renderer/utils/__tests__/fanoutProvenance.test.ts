// #1481 — provenance join, prefix strip, task link and tooltip text.
import { describe, expect, it } from 'vitest';
import {
  displayWorkspaceName,
  provenanceCallerLabel,
  provenanceFromAudit,
  provenanceTooltip,
  resolveCallerPane,
  resolveTaskLink,
  originFromCaller,
  resolveTaskRequester,
  requesterLine,
  countTasksRequestedByPane,
} from '../fanoutProvenance';
import type { WorkTask } from '../../../shared/workTask';
import type { Workspace } from '../../../shared/types';

const en: Record<string, string> = {
  'sidebar.provenance.by': 'Fanned out by {owner}',
  'sidebar.provenance.callerGui': 'you (GUI)',
  'sidebar.provenance.callerOrchestrator': 'orchestrator',
  'sidebar.provenance.callerPane': 'an agent pane',
  'sidebar.provenance.closedOwner': 'a closed workspace',
  'sidebar.requester.by': 'Requested by {name}',
  'sidebar.requester.gui': 'Started by you',
  'sidebar.requester.orchestrator': 'Orchestrator',
  'sidebar.requester.unknown': 'Requester unknown',
  'sidebar.requester.closedPane': '{name} · closed',
};
const t = ((key: string, vars?: Record<string, string | number>) =>
  (en[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars?.[k] ?? ''))) as never;

describe('displayWorkspaceName', () => {
  it('drops the task prefix for a task row only', () => {
    expect(displayWorkspaceName('wtask: fix login', true)).toBe('fix login');
    expect(displayWorkspaceName('wtask: fix login', false)).toBe('wtask: fix login');
  });

  it('keeps a renamed task and never empties a name', () => {
    expect(displayWorkspaceName('my name', true)).toBe('my name');
    expect(displayWorkspaceName('wtask: ', true)).toBe('wtask: ');
  });
});

describe('provenanceFromAudit', () => {
  it('maps each launched task workspace to its owner, caller and time; skips failures and start records', () => {
    const map = provenanceFromAudit([
      { at: 1, kind: 'start', ownerWorkspaceId: 'o', callerIdentity: 'gui' },
      { at: 2, kind: 'launched', ownerWorkspaceId: 'o', callerIdentity: 'pty', callerPtyId: 'pty-9',
        launched: [{ title: 'a', workspaceId: 'ws-a' }, { title: 'b', error: 'boom' }] },
      { at: 3, kind: 'launched', ownerWorkspaceId: 'o2', callerIdentity: 'commander', launched: [{ title: 'c', workspaceId: 'ws-c' }] },
    ]);
    expect(map).toEqual({
      'ws-a': { ownerWorkspaceId: 'o', callerIdentity: 'pty', callerPtyId: 'pty-9', at: 2 },
      'ws-c': { ownerWorkspaceId: 'o2', callerIdentity: 'commander', at: 3 },
    });
  });
});

describe('resolveTaskLink', () => {
  const mission = (extra: Partial<WorkTask> = {}) =>
    ({ owner: { verifiedWorkspaceId: 'owner', principalId: 'owner' }, ...extra } as WorkTask);

  it('prefers the ledger, which knows about detach', () => {
    expect(resolveTaskLink(mission({ detachedAt: 5 }), 'other', 'other')).toEqual({ ownerId: 'owner', detached: true });
  });

  // #1481 review B6 — durable lineage, not the audit window, links an old task.
  it('falls back to the durable lineage stamp, then the spawn stamp', () => {
    expect(resolveTaskLink(undefined, 'o')).toEqual({ ownerId: 'o', detached: false });
    expect(resolveTaskLink(undefined, undefined, 'owner')).toEqual({ ownerId: 'owner', detached: false });
  });

  // #1481 review B8 — a name is not evidence.
  it('does not treat a workspace named with the task prefix as a task', () => {
    expect(resolveTaskLink(undefined, undefined, undefined)).toBeNull();
  });
});

describe('provenance tooltip', () => {
  it('reads "Fanned out by <owner> · <caller> · <time>"', () => {
    const caller = provenanceCallerLabel({ callerIdentity: 'gui' }, () => undefined, t);
    expect(provenanceTooltip({ ownerName: 'api', caller, when: '3m ago' }, t)).toBe('Fanned out by api · you (GUI) · 3m ago');
  });

  it('names the orchestrator, the calling pane, or a generic pane', () => {
    expect(provenanceCallerLabel({ callerIdentity: 'commander' }, () => undefined, t)).toBe('orchestrator');
    expect(provenanceCallerLabel({ callerIdentity: 'pty', callerPtyId: 'p1' }, () => 'w1-2 (Claude Code)', t)).toBe('w1-2 (Claude Code)');
    expect(provenanceCallerLabel({ callerIdentity: 'pty' }, () => 'never', t)).toBe('an agent pane');
  });

  it('says the owner is closed when it cannot be named, and drops unknown parts', () => {
    expect(provenanceTooltip({}, t)).toBe('Fanned out by a closed workspace');
  });

  it('resolves a caller ptyId to its pane label and agent', () => {
    const ws = {
      id: 'w', name: 'w', wsOrdinal: 1, activePaneId: 'p',
      rootPane: { id: 'p', type: 'leaf', ordinal: 2, activeSurfaceId: 's', surfaces: [{ id: 's', ptyId: 'pty-1', title: '', shell: 'zsh', cwd: '/' }] },
    } as unknown as Workspace;
    expect(resolveCallerPane({ workspaces: [ws], paneLabel: { p: 'planner' }, surfaceAgent: { 'pty-1': { name: 'Claude Code' } } }, 'pty-1'))
      .toBe('planner (Claude Code)');
    expect(resolveCallerPane({ workspaces: [ws] }, 'gone')).toBeUndefined();
  });
});

describe('requester origin (who asked for a task)', () => {
  // One workspace (w115) with two agent panes: 62 and 74.
  const leaf = (id: string, ordinal: number, sid: string, ptyId: string) =>
    ({ id, type: 'leaf', ordinal, activeSurfaceId: sid, surfaces: [{ id: sid, ptyId, title: '', shell: 'zsh', cwd: '/' }] });
  const owner = {
    id: 'ws-owner', name: 'app', wsOrdinal: 115, activePaneId: 'p62',
    rootPane: { id: 'split', type: 'branch', direction: 'horizontal', children: [leaf('p62', 62, 's62', 'pty-62'), leaf('p74', 74, 's74', 'pty-74')], sizes: [50, 50] },
  } as unknown as Workspace;
  const task = (id: string) => ({ id, name: `wtask: ${id}`, wsOrdinal: 200, activePaneId: 'x', rootPane: leaf(`${id}-p`, 1, `${id}-s`, `${id}-pty`) }) as unknown as Workspace;
  const base = { workspaces: [owner], paneLabel: { p74: 'Compare' }, surfaceAgent: { 'pty-62': { name: 'Codex CLI' } } };

  it('records a pane caller by its stable pane/surface ids and a name snapshot, never the ptyId', () => {
    expect(originFromCaller(base, { kind: 'pane', ptyId: 'pty-74' }))
      .toEqual({ kind: 'pane', paneId: 'p74', surfaceId: 's74', label: 'Compare · w115-74' });
    expect(originFromCaller(base, { kind: 'pane', ptyId: 'pty-62' }))
      .toEqual({ kind: 'pane', paneId: 'p62', surfaceId: 's62', label: 'Codex CLI · w115-62' });
    expect(originFromCaller(base, { kind: 'orchestrator' })).toEqual({ kind: 'orchestrator' });
    expect(originFromCaller(base, { kind: 'gui' })).toEqual({ kind: 'gui' });
    expect(originFromCaller(base, { kind: 'pane', ptyId: 'gone' })).toEqual({ kind: 'pane' });
    expect(originFromCaller(base, undefined)).toBeUndefined();
  });

  it('shows the live label for an open pane, and the snapshot marked closed once it is gone', () => {
    const origin = { kind: 'pane' as const, paneId: 'p74', surfaceId: 's74', label: 'Compare · w115-74' };
    const live = resolveTaskRequester({ ...base, paneLabel: { p74: 'Renamed' }, fanoutOrigin: { t1: origin } }, 't1');
    expect(live).toEqual({ kind: 'pane', live: true, label: 'Renamed · w115-74', workspaceId: 'ws-owner', paneId: 'p74', surfaceId: 's74' });
    expect(requesterLine(live, t)).toBe('Requested by Renamed · w115-74');

    const gone = resolveTaskRequester({ workspaces: [], fanoutOrigin: { t1: origin } }, 't1');
    expect(gone).toEqual({ kind: 'pane', live: false, label: 'Compare · w115-74', closed: true });
    expect(requesterLine(gone, t)).toBe('Requested by Compare · w115-74 · closed');
  });

  it('prefers the origin over the audit caller, falls back to the audit for older tasks, and never guesses', () => {
    const state = {
      ...base,
      fanoutOrigin: { t1: { kind: 'gui' as const }, t2: { kind: 'orchestrator' as const } },
      fanoutProvenance: {
        t1: { ownerWorkspaceId: 'ws-owner', callerIdentity: 'pty' as const, callerPtyId: 'pty-62', at: 1 },
        t3: { ownerWorkspaceId: 'ws-owner', callerIdentity: 'pty' as const, callerPtyId: 'pty-62', at: 1 },
        t4: { ownerWorkspaceId: 'ws-owner', callerIdentity: 'pty' as const, callerPtyId: 'rebound', at: 1 },
      },
    };
    expect(requesterLine(resolveTaskRequester(state, 't1'), t)).toBe('Started by you');
    expect(requesterLine(resolveTaskRequester(state, 't2'), t)).toBe('Requested by Orchestrator');
    expect(requesterLine(resolveTaskRequester(state, 't3'), t)).toBe('Requested by Codex CLI · w115-62');
    // A ptyId no pane holds may have been rebound: not called closed.
    expect(requesterLine(resolveTaskRequester(state, 't4'), t)).toBe('Requested by an agent pane');
    expect(requesterLine(resolveTaskRequester(state, 't5'), t)).toBe('Requester unknown');
  });

  it('counts each pane its own open requested tasks', () => {
    const state = {
      ...base,
      workspaces: [owner, task('t1'), task('t2'), task('t3'), task('t4')],
      fanoutOrigin: {
        t1: { kind: 'pane' as const, paneId: 'p62' },
        t2: { kind: 'pane' as const, paneId: 'p74' },
        t3: { kind: 'pane' as const, paneId: 'p74' },
        t4: { kind: 'pane' as const, paneId: 'p74' },
      },
      missionByPaneGroup: { t4: { detachedAt: 5 } },
    };
    expect(countTasksRequestedByPane(state, 'p62')).toBe(1);
    expect(countTasksRequestedByPane(state, 'p74')).toBe(2);
    expect(countTasksRequestedByPane(state, 'nope')).toBe(0);
  });
});
