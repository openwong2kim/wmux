// A pane waiting out a provider usage limit is not an error and does not need
// the user (owner decision 2026-10-03): its `error` drops out of the status,
// the counts and the red marks while the hold stands, and comes back once the
// reset passed without a release.
import { describe, it, expect } from 'vitest';
import { countNeedsAttention, fleetAttentionClass, fleetRow, selectFleetPanes } from '../fleet';
import { selectWorkspaceAgentRoster } from '../workspaceAgentRoster';
import { rowStatusMark } from '../../../components/Sidebar/AgentMarks';
import {
  nextUsageLimitWaitingChange,
  usageLimitWaitingMap,
  workspaceHasUsageLimitWaiting,
} from '../../slices/usageLimitSlice';
import { USAGE_LIMIT_RESUME_GRACE_MS, type PaneUsageLimit } from '../../../../shared/usageLimit';
import type { StoreState } from '../../index';
import type { AgentStatus, Pane, Surface, Workspace } from '../../../../shared/types';

const PTY = 'pty-limit';
const surface: Surface = { id: 's1', ptyId: PTY, title: 'claude', shell: 'zsh', cwd: '/repo', surfaceType: 'terminal' };
const leaf: Pane = { id: 'p1', type: 'leaf', surfaces: [surface], activeSurfaceId: 's1' };
const ws: Workspace = { id: 'w1', name: 'w1', rootPane: leaf, activePaneId: 'p1' };

function rosterState(waiting: Record<string, true>, agentStatus: AgentStatus = 'error'): StoreState {
  return {
    workspaces: [ws],
    activeWorkspaceId: 'w1',
    surfaceAgent: { [PTY]: { name: 'Claude Code', status: agentStatus } },
    surfaceAgentStatus: { [PTY]: 'error' },
    surfacePendingQuestion: {},
    surfaceQuestionSeen: {},
    surfaceActivity: {},
    surfaceActivityAt: {},
    surfaceTurnOpenAt: {},
    paneLabel: {},
    agentClockMs: 0,
    remoteWorkspaces: [],
    usageLimitWaiting: waiting,
  } as unknown as StoreState;
}

describe('usage-limit waiting presentation', () => {
  const fleetBase = {
    workspaces: [ws],
    surfaceAgentStatus: { [PTY]: 'error' as AgentStatus },
    surfaceActivity: {},
    surfaceAgent: { [PTY]: { name: 'Claude Code', status: 'error' as AgentStatus } },
  };

  it('Fleet: a held pane is idle-class Waiting, not an error that needs you', () => {
    const [held] = selectFleetPanes({ ...fleetBase, usageLimitWaiting: { [PTY]: true } });
    expect(held.agentStatus).not.toBe('error');
    expect(held.usageLimitWaiting).toBe(true);
    expect(fleetAttentionClass(held)).toBe('idle');
    expect(fleetRow(held).section).toBe('idle');
    expect(countNeedsAttention([held])).toBe(0);
  });

  it('Fleet: once the hold ended (no longer waiting) the same pane is attention again', () => {
    const [expired] = selectFleetPanes({ ...fleetBase, usageLimitWaiting: {} });
    expect(expired.agentStatus).toBe('error');
    expect(expired.usageLimitWaiting).toBeUndefined();
    expect(fleetAttentionClass(expired)).toBe('needsYou');
  });

  it('Sidebar roster: no red ✕ and no attention while held; a waiting clock instead', () => {
    const held = selectWorkspaceAgentRoster(rosterState({ [PTY]: true }), 'w1');
    expect(held.rows[0]).toMatchObject({ status: 'idle', usageLimitWaiting: true, hasAttention: false, needsAttention: false });
    expect(held.needsAttentionCount).toBe(0);
    expect(rowStatusMark(held.rows[0].status, false, true)).toBe('waiting');

    const expired = selectWorkspaceAgentRoster(rosterState({}), 'w1');
    expect(expired.rows[0]).toMatchObject({ status: 'error', needsAttention: true });
    expect(expired.rows[0].usageLimitWaiting).toBeUndefined();
    expect(rowStatusMark(expired.rows[0].status, false, false)).toBe('cross');
  });

  it('a louder mark still wins over the waiting clock', () => {
    expect(rowStatusMark('running', false, true)).toBe('dot');
    expect(rowStatusMark('idle', true, true)).toBe('unconfirmed');
  });

  it('the waiting map follows the hold and names when it next changes', () => {
    const now = 1_000_000;
    const limits: Record<string, PaneUsageLimit> = {
      a: { ptyId: 'a', provider: 'claude', detectedAt: now - 10, resetsAt: now + 60_000, source: 'hook' },
      b: { ptyId: 'b', provider: 'claude', detectedAt: now - 10, resetsAt: now - USAGE_LIMIT_RESUME_GRACE_MS - 1, source: 'hook' },
    };
    expect(usageLimitWaitingMap(limits, now)).toEqual({ a: true });
    expect(nextUsageLimitWaitingChange(limits, now)).toBe(now + 60_000 + USAGE_LIMIT_RESUME_GRACE_MS);
    expect(workspaceHasUsageLimitWaiting({ workspaces: [ws], usageLimitWaiting: { [PTY]: true } }, 'w1')).toBe(true);
    expect(workspaceHasUsageLimitWaiting({ workspaces: [ws], usageLimitWaiting: {} }, 'w1')).toBe(false);
  });
});
