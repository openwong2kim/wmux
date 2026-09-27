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
  requestedCountFor,
  selectRequestedCounts,
} from '../fanoutProvenance';
import type { WorkTask } from '../../../shared/workTask';
import type { Workspace } from '../../../shared/types';

const en: Record<string, string> = {
  'sidebar.provenance.by': 'Fanned out by {owner}',
  'sidebar.provenance.callerGui': 'you (GUI)',
  'sidebar.provenance.callerOrchestrator': 'orchestrator',
  'sidebar.provenance.callerPane': 'an agent pane',
  'sidebar.provenance.closedOwner': 'a closed workspace',
  'sidebar.requester.by': 'by {name}',
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
  // One workspace (w115) with two agent panes: 62 and 74. Pane 74 holds two
  // agent tabs (s74 and s74b).
  const surface = (sid: string, ptyId: string) => ({ id: sid, ptyId, title: '', shell: 'zsh', cwd: '/' });
  const leaf = (id: string, ordinal: number, surfaces: ReturnType<typeof surface>[]) =>
    ({ id, type: 'leaf', ordinal, activeSurfaceId: surfaces[0].id, surfaces });
  const ownerWith = (p74: ReturnType<typeof surface>[]) => ({
    id: 'ws-owner', name: 'app', wsOrdinal: 115, activePaneId: 'p62',
    rootPane: { id: 'split', type: 'branch', direction: 'horizontal', sizes: [50, 50],
      children: [leaf('p62', 62, [surface('s62', 'pty-62')]), leaf('p74', 74, p74)] },
  }) as unknown as Workspace;
  const owner = ownerWith([surface('s74', 'pty-74'), surface('s74b', 'pty-74b')]);
  const task = (id: string) => ({ id, name: `wtask: ${id}`, wsOrdinal: 200, activePaneId: 'x', rootPane: leaf(`${id}-p`, 1, [surface(`${id}-s`, `${id}-pty`)]) }) as unknown as Workspace;
  const base = { workspaces: [owner], paneLabel: { p74: 'Compare' }, surfaceAgent: { 'pty-62': { name: 'Codex CLI' } } };

  it('records a pane caller by its stable pane/surface ids and a name snapshot — coordinate first — never the ptyId', () => {
    expect(originFromCaller(base, { kind: 'pane', ptyId: 'pty-74' }))
      .toEqual({ kind: 'pane', paneId: 'p74', surfaceId: 's74', label: 'w115-74 · Compare' });
    expect(originFromCaller(base, { kind: 'pane', ptyId: 'pty-62' }))
      .toEqual({ kind: 'pane', paneId: 'p62', surfaceId: 's62', label: 'w115-62 · Codex CLI' });
    expect(originFromCaller(base, { kind: 'orchestrator' })).toEqual({ kind: 'orchestrator' });
    expect(originFromCaller(base, { kind: 'gui' })).toEqual({ kind: 'gui' });
    // A pane nobody holds records nothing, rather than an id-less stamp.
    expect(originFromCaller(base, { kind: 'pane', ptyId: 'gone' })).toBeUndefined();
    expect(originFromCaller(base, undefined)).toBeUndefined();
  });

  it('shows the live label for an open pane, and the snapshot marked closed once it is gone', () => {
    const origin = { kind: 'pane' as const, paneId: 'p74', surfaceId: 's74', label: 'w115-74 · Compare' };
    const live = resolveTaskRequester({ ...base, paneLabel: { p74: 'Renamed' }, fanoutOrigin: { t1: origin } }, 't1');
    expect(live).toEqual({ kind: 'pane', live: true, label: 'w115-74 · Renamed', workspaceId: 'ws-owner', paneId: 'p74', surfaceId: 's74' });
    expect(requesterLine(live, t)).toBe('by w115-74 · Renamed');

    const gone = resolveTaskRequester({ workspaces: [], fanoutOrigin: { t1: origin } }, 't1');
    expect(gone).toEqual({ kind: 'pane', live: false, label: 'w115-74 · Compare' });
    expect(requesterLine(gone, t)).toBe('by w115-74 · Compare · closed');
    // Older snapshots were joined name-first; the coordinate still leads.
    expect(resolveTaskRequester({ workspaces: [], fanoutOrigin: { t1: { ...origin, label: 'Claude Code · w1-1' } } }, 't1'))
      .toEqual({ kind: 'pane', live: false, label: 'w1-1 · Claude Code' });
  });

  it('a recorded surface that left its pane is closed — the pane\'s other (active) tab is not the requester', () => {
    const origin = { kind: 'pane' as const, paneId: 'p74', surfaceId: 's74b', label: 'w115-74 · Compare' };
    // s74b closed; s74 is still in p74 and is its active tab.
    const state = { ...base, workspaces: [ownerWith([surface('s74', 'pty-74')])], fanoutOrigin: { t1: origin } };
    expect(resolveTaskRequester(state, 't1')).toEqual({ kind: 'pane', live: false, label: 'w115-74 · Compare' });
    // A surface moved to another pane is still found by its own id.
    expect(resolveTaskRequester({ ...base, fanoutOrigin: { t1: { ...origin, paneId: 'p62' } } }, 't1'))
      .toMatchObject({ live: true, paneId: 'p74', surfaceId: 's74b' });
    // Only an origin without a surfaceId uses the pane's active tab.
    expect(resolveTaskRequester({ ...base, fanoutOrigin: { t1: { kind: 'pane', paneId: 'p74' } } }, 't1'))
      .toMatchObject({ live: true, surfaceId: 's74' });
  });

  it('prefers the origin, trusts only the audit caller KIND, and never resolves an audit ptyId', () => {
    const state = {
      ...base,
      fanoutOrigin: { t1: { kind: 'gui' as const }, t2: { kind: 'orchestrator' as const } },
      fanoutProvenance: {
        t1: { ownerWorkspaceId: 'ws-owner', callerIdentity: 'pty' as const, callerPtyId: 'pty-62', at: 1 },
        t3: { ownerWorkspaceId: 'ws-owner', callerIdentity: 'pty' as const, callerPtyId: 'pty-62', at: 1 },
        t4: { ownerWorkspaceId: 'ws-owner', callerIdentity: 'gui' as const, at: 1 },
        t6: { ownerWorkspaceId: 'ws-owner', callerIdentity: 'commander' as const, at: 1 },
      },
    };
    expect(requesterLine(resolveTaskRequester(state, 't1'), t)).toBe('Started by you');
    expect(requesterLine(resolveTaskRequester(state, 't2'), t)).toBe('by Orchestrator');
    // pty-62 is open, but a PTY id may have been reused since: not a requester.
    expect(resolveTaskRequester(state, 't3')).toEqual({ kind: 'unknown' });
    expect(requesterLine(resolveTaskRequester(state, 't4'), t)).toBe('Started by you');
    expect(requesterLine(resolveTaskRequester(state, 't6'), t)).toBe('by Orchestrator');
    expect(requesterLine(resolveTaskRequester(state, 't5'), t)).toBe('Requester unknown');
  });

  it('counts per requesting surface, scoped to the owner the task nests under', () => {
    const state = {
      ...base,
      workspaces: [owner, task('t1'), task('t2'), task('t3'), task('t4'), task('t5'), task('t6')],
      fanoutOrigin: {
        t1: { kind: 'pane' as const, paneId: 'p62', surfaceId: 's62' },
        t2: { kind: 'pane' as const, paneId: 'p74', surfaceId: 's74' },
        t3: { kind: 'pane' as const, paneId: 'p74', surfaceId: 's74' },
        t4: { kind: 'pane' as const, paneId: 'p74', surfaceId: 's74' },
        t5: { kind: 'pane' as const, paneId: 'p74', surfaceId: 's74b' },
        t6: { kind: 'pane' as const, paneId: 'p74', surfaceId: 's74' },
      },
      fanoutLineage: { t1: 'ws-owner', t2: 'ws-owner', t3: 'ws-owner', t4: 'ws-owner', t5: 'ws-owner', t6: 'ws-other' },
      missionByPaneGroup: { t4: { owner: { verifiedWorkspaceId: 'ws-owner', principalId: 'ws-owner' }, detachedAt: 5 } as WorkTask },
    };
    const counts = selectRequestedCounts(state);
    expect(selectRequestedCounts(state)).toBe(counts); // memoized
    expect(requestedCountFor(counts, 'ws-owner', { paneId: 'p62', surfaceId: 's62' })).toBe(1);
    // Two agent tabs in one pane each count their own (t4 is detached, t6 nests elsewhere).
    expect(requestedCountFor(counts, 'ws-owner', { paneId: 'p74', surfaceId: 's74' })).toBe(2);
    expect(requestedCountFor(counts, 'ws-owner', { paneId: 'p74', surfaceId: 's74b' })).toBe(1);
    expect(requestedCountFor(counts, 'ws-other', { paneId: 'p74', surfaceId: 's74' })).toBe(1);
    expect(requestedCountFor(counts, 'ws-owner', { paneId: 'nope', surfaceId: 'nope' })).toBe(0);
  });
});
