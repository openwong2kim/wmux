// Glance board (2026-09-25): one classification for the sidebar and Fleet, and
// the sidebar's "changed since you last looked" dot.
import { describe, expect, it } from 'vitest';
import {
  ATTENTION_CLASS_RANK,
  attentionScore,
  fleetAttentionClass,
  fleetRow,
  sectionOfAttentionClass,
  selectFleetPanes,
  selectWorkspaceAttentionScores,
  type FleetPane,
} from '../fleet';
import { seenPanes, seenUpdates, selectSidebarUnseen, selectSidebarUnseenWorkspaces } from '../sidebarSeen';
import type { StoreState } from '../../index';
import type { AgentStatus, Pane, Surface, Workspace } from '../../../../shared/types';

function surface(id: string, ptyId: string): Surface {
  return { id, ptyId, title: id, shell: 'zsh', cwd: '/r', surfaceType: 'terminal' };
}
function ws(id: string, ptyId: string): Workspace {
  const rootPane: Pane = { id: `${id}-p`, type: 'leaf', surfaces: [surface(`${id}-s`, ptyId)], activeSurfaceId: `${id}-s` };
  return { id, name: id, rootPane, activePaneId: `${id}-p` };
}
const NOW = 10_000_000;

function state(statuses: Record<string, AgentStatus>, extra: Partial<Record<string, unknown>> = {}): StoreState {
  const ids = Object.keys(statuses);
  return {
    workspaces: ids.map((id) => ws(id, `pty-${id}`)),
    activeWorkspaceId: '',
    multiviewIds: [],
    surfaceAgent: Object.fromEntries(ids.map((id) => [`pty-${id}`, { name: 'Claude Code', status: statuses[id] }])),
    surfaceAgentStatus: Object.fromEntries(ids.filter((id) => statuses[id] !== 'running' && statuses[id] !== 'idle').map((id) => [`pty-${id}`, statuses[id]])),
    surfacePendingQuestion: {},
    surfaceActivity: {},
    surfaceActivityAt: Object.fromEntries(ids.map((id, i) => [`pty-${id}`, NOW - i * 60_000])),
    surfaceTurnOpenAt: Object.fromEntries(ids.filter((id) => statuses[id] === 'running').map((id) => [`pty-${id}`, NOW])),
    paneLabel: {},
    agentClockMs: NOW,
    remoteWorkspaces: [],
    sidebarSeen: {},
    ...extra,
  } as unknown as StoreState;
}

describe('sidebar class ⇄ Fleet section parity', () => {
  it('puts every pane in the Fleet section its sidebar class maps to (same fixture)', () => {
    const s = state({ a: 'awaiting_input', b: 'complete', c: 'running', d: 'idle', e: 'error', f: 'waiting' });
    const panes = selectFleetPanes(s);
    expect(panes.length).toBe(6);
    for (const pane of panes) {
      const cls = fleetAttentionClass(pane, s.surfacePendingQuestion[pane.ptyId]);
      expect(fleetRow(pane, s).section, `${pane.workspaceId}:${pane.agentStatus}`).toBe(sectionOfAttentionClass(cls));
    }
  });

  it('classifies unconfirmed, finished and waiting-with-question distinctly', () => {
    const base = { agentStatus: 'running', unverifiable: false } as Pick<FleetPane, 'agentStatus' | 'unverifiable' | 'supervision'>;
    expect(fleetAttentionClass({ ...base, unverifiable: true })).toBe('unconfirmed');
    expect(fleetAttentionClass({ ...base, agentStatus: 'complete' })).toBe('finished');
    expect(fleetAttentionClass({ ...base, agentStatus: 'waiting' }, 'Which one?')).toBe('needsYou');
    expect(fleetAttentionClass({ ...base, agentStatus: 'waiting' })).toBe('idle');
  });
});

describe('selectWorkspaceAttentionScores', () => {
  it('scores by the most urgent class, then the newest stamp', () => {
    const scores = selectWorkspaceAttentionScores(state({ a: 'running', b: 'awaiting_input', c: 'complete' }));
    expect(scores.b).toBe(attentionScore(ATTENTION_CLASS_RANK.needsYou, Math.floor((NOW - 60_000) / 60_000)));
    expect(scores.b < scores.c && scores.c < scores.a).toBe(true);
  });
});

describe('changed-since-you-last-looked', () => {
  it('seeds a pane the first time it is seen, so it opens without a dot', () => {
    const s = state({ a: 'running' });
    const updates = seenUpdates(seenPanes(s), new Set(), {});
    expect(updates['pty-a']).toEqual({ status: 'running' });
    expect(selectSidebarUnseen({ ...s, sidebarSeen: {} } as StoreState)).toEqual({});
  });

  it('sets the dot when an out-of-view pane finishes or needs you after it was seen', () => {
    const s = state({ a: 'complete', b: 'awaiting_input', c: 'running' }, {
      sidebarSeen: { 'pty-a': { status: 'running' }, 'pty-b': { status: 'running' }, 'pty-c': { status: 'idle' } },
    });
    expect(selectSidebarUnseen(s)).toEqual({ 'pty-a': true, 'pty-b': true });
    expect(selectSidebarUnseenWorkspaces(s)).toEqual({ a: true, b: true });
  });

  it('clears when the workspace is in view: no dot, and the snapshot catches up', () => {
    const seen = { 'pty-a': { status: 'running' as AgentStatus } };
    const s = state({ a: 'complete' }, { sidebarSeen: seen, activeWorkspaceId: 'a' });
    expect(selectSidebarUnseen(s)).toEqual({});
    expect(seenUpdates(seenPanes(s), new Set(['a']), seen)).toEqual({ 'pty-a': { status: 'complete' } });
  });
});
