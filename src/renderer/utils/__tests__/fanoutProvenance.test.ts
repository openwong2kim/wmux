// #1481 — provenance join, prefix strip, task link and tooltip text.
import { describe, expect, it } from 'vitest';
import {
  displayWorkspaceName,
  provenanceCallerLabel,
  provenanceFromAudit,
  provenanceTooltip,
  resolveCallerPane,
  resolveTaskLink,
} from '../fanoutProvenance';
import type { WorkTask } from '../../../shared/workTask';
import type { Workspace } from '../../../shared/types';

const en: Record<string, string> = {
  'sidebar.provenance.by': 'Fanned out by {owner}',
  'sidebar.provenance.callerGui': 'you (GUI)',
  'sidebar.provenance.callerOrchestrator': 'orchestrator',
  'sidebar.provenance.callerPane': 'an agent pane',
  'sidebar.provenance.closedOwner': 'a closed workspace',
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
