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
import { seenTabs, seenUpdates, selectSidebarUnseen, selectSidebarUnseenWorkspaces, visibleWorkspaceIds } from '../sidebarSeen';
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

const rec = (status: AgentStatus, rev = 0, seenRev = rev) => ({ entry: { status }, rev, seenRev });

describe('changed-since-you-last-looked', () => {
  it('seeds a tab the first time it is seen, so it opens without a dot', () => {
    const s = state({ a: 'running' });
    const { updates } = seenUpdates(seenTabs(s), new Set(), {});
    expect(updates['pty-a']).toEqual(rec('running'));
    expect(selectSidebarUnseen(s)).toEqual({});
  });

  it('sets the dot when an out-of-view tab finishes or needs you after it was seen', () => {
    const s = state({ a: 'complete', b: 'awaiting_input', c: 'running' }, {
      sidebarSeen: { 'pty-a': rec('complete', 1, 0), 'pty-b': rec('awaiting_input', 1, 0), 'pty-c': rec('running', 1, 0) },
    });
    expect(selectSidebarUnseen(s)).toEqual({ 'pty-a': true, 'pty-b': true });
    expect(selectSidebarUnseenWorkspaces(s)).toEqual({ a: true, b: true });
  });

  it('clears when the workspace is in view: no dot, and seenRev catches up', () => {
    const seen = { 'pty-a': rec('running') };
    const s = state({ a: 'complete' }, { sidebarSeen: seen, activeWorkspaceId: 'a' });
    expect(selectSidebarUnseen(s)).toEqual({});
    expect(seenUpdates(seenTabs(s), new Set(['a']), seen).updates['pty-a']).toEqual({ entry: { status: 'complete' }, rev: 1, seenRev: 1 });
  });

  // Review #6 — a round trip is still a change.
  it('counts a round trip (complete → running → complete) as unseen', () => {
    let seen: Record<string, ReturnType<typeof rec>> = { 'pty-a': rec('complete') };
    for (const status of ['running', 'complete'] as AgentStatus[]) {
      const next = seenUpdates(seenTabs(state({ a: status })), new Set(), seen).updates;
      seen = { ...seen, ...next };
    }
    expect(seen['pty-a']).toMatchObject({ rev: 2, seenRev: 0 });
    expect(selectSidebarUnseen(state({ a: 'complete' }, { sidebarSeen: seen }))).toEqual({ 'pty-a': true });
  });

  it('prunes records of ptys that no longer exist, but keeps one whose agent is momentarily undetected', () => {
    const s = state({ a: 'idle' });
    expect(seenUpdates(seenTabs(s), new Set(), { 'pty-gone': rec('idle') }, new Set(['pty-a'])).removed).toEqual(['pty-gone']);
    // pty-b still has a surface, its agent just restarted: the record stays.
    expect(seenUpdates([], new Set(), { 'pty-b': rec('running') }, new Set(['pty-b'])).removed).toEqual([]);
  });

  // Review #5 — per agent TAB: a background tab gets its own record and dot.
  it('tracks a background agent tab behind the active one', () => {
    const s = state({ a: 'running' });
    const w = s.workspaces[0];
    const leaf = w.rootPane as Extract<Pane, { type: 'leaf' }>;
    leaf.surfaces.push({ ...leaf.surfaces[0], id: 'a-s2', ptyId: 'pty-a2' });
    const s2 = { ...s, surfaceAgent: { ...s.surfaceAgent, 'pty-a2': { name: 'Claude Code', status: 'complete' } }, surfaceAgentStatus: { 'pty-a2': 'complete' }, sidebarSeen: { 'pty-a': rec('running'), 'pty-a2': rec('complete', 1, 0) } } as unknown as StoreState;
    expect(seenTabs(s2).map((t) => t.ptyId)).toEqual(['pty-a', 'pty-a2']);
    expect(selectSidebarUnseen(s2)).toEqual({ 'pty-a2': true });
  });
});

// Review #1 — visibility follows what is actually on screen.
describe('visibleWorkspaceIds', () => {
  it('counts the multiview grid only while the active workspace is part of it', () => {
    expect([...visibleWorkspaceIds({ activeWorkspaceId: 'a', multiviewIds: ['a', 'b'] })].sort()).toEqual(['a', 'b']);
    expect([...visibleWorkspaceIds({ activeWorkspaceId: 'c', multiviewIds: ['a', 'b'] })]).toEqual(['c']);
  });
  it('hides every local workspace while a remote mirror is showing', () => {
    const remoteWorkspaces = [{ key: 'h:1', stale: false, ephemeral: false }] as unknown as StoreState['remoteWorkspaces'];
    expect([...visibleWorkspaceIds({ activeWorkspaceId: 'a', multiviewIds: [], activeRemoteKey: 'h:1', remoteWorkspaces })]).toEqual([]);
  });
});

// Review #2/#4 — one rule for plain waiting; a terminal behind a browser tab still counts.
describe('shared class edge cases', () => {
  it('scores plain waiting (no question) as idle, like Fleet', () => {
    const s = state({ w: 'waiting', r: 'running' });
    const scores = selectWorkspaceAttentionScores(s);
    expect(scores.r < scores.w).toBe(true);
  });
  it('keeps an agent waiting behind a browser tab as needs you', () => {
    const s = state({ a: 'awaiting_input', b: 'running' });
    const leaf = s.workspaces[0].rootPane as Extract<Pane, { type: 'leaf' }>;
    leaf.surfaces.push({ id: 'a-browser', ptyId: '', title: '', shell: '', cwd: '', surfaceType: 'browser' } as never);
    leaf.activeSurfaceId = 'a-browser';
    const scores = selectWorkspaceAttentionScores({ ...s } as StoreState);
    expect(scores.a < scores.b).toBe(true);
  });
});
