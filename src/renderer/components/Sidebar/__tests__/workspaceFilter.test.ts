import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTER, factsFromKey, filterChips, isFilterActive, matchesFilter, selectWorkspaceFactKeys, statusFacet, toggleFacet,
  type WorkspaceFacts, type WorkspaceFilter,
} from '../workspaceFilter';
import type { StoreState } from '../../../stores';
import type { Pane, Workspace } from '../../../../shared/types';

const facts = (over: Partial<WorkspaceFacts> = {}): WorkspaceFacts => ({
  status: 'idle', hasAgent: true, agents: ['claude'], hasPr: false, hasChanges: false, isTask: false, ...over,
});
const f = (over: Partial<WorkspaceFilter>): WorkspaceFilter => ({ ...EMPTY_FILTER, ...over });

describe('workspace filter', () => {
  it('ORs checks inside a group and ANDs the groups', () => {
    const filter = f({ status: ['needsYou', 'running'], agent: ['codex'] });
    expect(matchesFilter(filter, facts({ status: 'running', agents: ['codex'] }))).toBe(true);
    expect(matchesFilter(filter, facts({ status: 'needsYou', agents: ['claude', 'codex'] }))).toBe(true);
    expect(matchesFilter(filter, facts({ status: 'idle', agents: ['codex'] }))).toBe(false);
    expect(matchesFilter(filter, facts({ status: 'running', agents: ['claude'] }))).toBe(false);
    // Other: PR or changes or tasks.
    const other = f({ other: ['pr', 'changes'] });
    expect(matchesFilter(other, facts({ hasChanges: true }))).toBe(true);
    expect(matchesFilter(other, facts())).toBe(false);
    // Kind: a terminal-only workspace has no agent.
    expect(matchesFilter(f({ kind: ['terminal'] }), facts({ hasAgent: false, agents: [] }))).toBe(true);
    expect(matchesFilter(f({ kind: ['terminal'] }), facts())).toBe(false);
    expect(matchesFilter(EMPTY_FILTER, facts())).toBe(true);
  });

  it('hides fan-out tasks, and "tasks only" and "hide tasks" never hold together', () => {
    expect(matchesFilter(f({ hideTasks: true }), facts({ isTask: true }))).toBe(false);
    let filter = toggleFacet(EMPTY_FILTER, { group: 'other', value: 'tasks' });
    filter = toggleFacet(filter, { group: 'hideTasks', value: true });
    expect(filter.hideTasks).toBe(true);
    expect(filter.other).toEqual([]);
    filter = toggleFacet(filter, { group: 'other', value: 'tasks' });
    expect(filter.hideTasks).toBe(false);
  });

  it('lists the checks in force as chips and removes one at a time', () => {
    const filter = f({ status: ['running'], other: ['pr'], hideTasks: true });
    expect(isFilterActive(filter)).toBe(true);
    const chips = filterChips(filter);
    expect(chips.map((c) => `${c.group}:${String(c.value)}`)).toEqual(['status:running', 'other:pr', 'hideTasks:true']);
    const after = toggleFacet(filter, chips[0]);
    expect(after.status).toEqual([]);
    expect(isFilterActive(toggleFacet(toggleFacet(after, chips[1]), chips[2]))).toBe(false);
  });

  it('reads status with the sidebar classification', () => {
    expect(statusFacet('awaiting_input', false)).toBe('needsYou');
    expect(statusFacet('complete', false)).toBe('needsYou');
    expect(statusFacet('running', true)).toBe('needsYou');
    expect(statusFacet('running', false)).toBe('running');
    expect(statusFacet('waiting', false)).toBe('idle');
  });

  it('reads a usage-limit hold as Waiting only where the row would be idle', () => {
    expect(statusFacet('idle', false, true)).toBe('usageWaiting');
    expect(statusFacet('waiting', false, true)).toBe('usageWaiting');
    // A louder status keeps its own facet, like the row's own mark.
    expect(statusFacet('running', false, true)).toBe('running');
    expect(statusFacet('awaiting_input', false, true)).toBe('needsYou');
    expect(statusFacet('idle', false, false)).toBe('idle');
    const waitingOnly = f({ status: ['usageWaiting'] });
    expect(matchesFilter(waitingOnly, facts({ status: 'usageWaiting' }))).toBe(true);
    expect(matchesFilter(waitingOnly, facts({ status: 'idle' }))).toBe(false);
  });

  it('derives the Waiting facet from the store for a workspace held at its usage limit', () => {
    const ws = (id: string, ptyId: string): Workspace => {
      const leaf: Pane = { id: `p-${id}`, type: 'leaf', activeSurfaceId: `s-${id}`,
        surfaces: [{ id: `s-${id}`, ptyId, title: 'claude', shell: 'zsh', cwd: '/repo', surfaceType: 'terminal' }] };
      return { id, name: id, rootPane: leaf, activePaneId: leaf.id };
    };
    const state = {
      workspaces: [ws('held', 'pty-held'), ws('free', 'pty-free')],
      activeWorkspaceId: 'held',
      surfaceAgent: {
        'pty-held': { name: 'Claude Code', slug: 'claude', status: 'error' },
        'pty-free': { name: 'Claude Code', slug: 'claude', status: 'idle' },
      },
      // The turn died on the limit: `error`, quieted while the hold stands.
      surfaceAgentStatus: { 'pty-held': 'error' },
      surfacePendingQuestion: {}, surfaceQuestionSeen: {}, surfaceActivity: {}, surfaceActivityAt: {},
      surfaceTurnOpenAt: {}, paneLabel: {}, agentClockMs: 0, remoteWorkspaces: [],
      missionByPaneGroup: {}, fanoutLineage: {}, fanoutSpawnOwner: {},
      usageLimitWaiting: { 'pty-held': true },
    } as unknown as StoreState;
    const keys = selectWorkspaceFactKeys(state);
    expect(factsFromKey(keys.held).status).toBe('usageWaiting');
    expect(factsFromKey(keys.free).status).toBe('idle');
  });
});
