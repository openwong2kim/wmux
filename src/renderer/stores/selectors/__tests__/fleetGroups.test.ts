import { describe, it, expect } from 'vitest';
import { groupFleetPanes, selectFleetPanes, selectSurfaceLastMessage, type FleetPane, type FleetRow } from '../fleet';
import type { Workspace } from '../../../../shared/types';

function pane(ptyId: string, overrides: Partial<FleetPane> = {}): FleetPane {
  return {
    workspaceId: `ws-${ptyId}`,
    workspaceName: ptyId,
    paneId: `p-${ptyId}`,
    surfaceId: `s-${ptyId}`,
    ptyId,
    agentStatus: 'idle',
    title: ptyId,
    surfaceType: 'terminal',
    isActivePane: true,
    unverifiable: false,
    ...overrides,
  };
}

const ids = (rows: FleetRow[]) => rows.map((row) => row.pane.ptyId);
const only = (panes: FleetPane[], ctx: Parameters<typeof groupFleetPanes>[1] = {}) => {
  const g = groupFleetPanes(panes, ctx);
  const all = [...g.needsYou, ...g.running, ...g.idle];
  expect(all).toHaveLength(1);
  return all[0];
};

describe('groupFleetPanes — status → section and detail (the SSOT table)', () => {
  it('awaiting_input → needsYou with the pending question, else "Needs your input"', () => {
    const asked = only([pane('a', { agentStatus: 'awaiting_input' })], { surfacePendingQuestion: { a: ' Which target? ' } });
    expect(asked).toMatchObject({ section: 'needsYou', detail: 'Which target?', detailSource: 'question' });
    const bare = only([pane('a', { agentStatus: 'awaiting_input' })]);
    expect(bare).toMatchObject({ section: 'needsYou', detailKey: 'fleet.needsYourInput' });
    expect(bare.detail).toBeUndefined();
  });

  it('waiting WITH a pending question → needsYou with the question', () => {
    const row = only([pane('w', { agentStatus: 'waiting' })], { surfacePendingQuestion: { w: 'Ship it?' } });
    expect(row).toMatchObject({ section: 'needsYou', detail: 'Ship it?', detailSource: 'question' });
  });

  it('waiting WITHOUT a question → idle with the last message, else the idle fallback', () => {
    const withMsg = only([pane('w', { agentStatus: 'waiting' })], { surfaceLastMessage: { w: 'Done with the refactor.' } });
    expect(withMsg).toMatchObject({ section: 'idle', detail: 'Done with the refactor.', detailSource: 'lastMessage' });
    expect(only([pane('w', { agentStatus: 'waiting' })])).toMatchObject({ section: 'idle', detailKey: 'fleet.detail.idle' });
  });

  it('error → needsYou with the error detail', () => {
    expect(only([pane('e', { agentStatus: 'error' })])).toMatchObject({ section: 'needsYou', detailKey: 'fleet.detail.error' });
  });

  it('unverifiable → needsYou with the 30m+ detail, even though its status is running', () => {
    const row = only([pane('u', { agentStatus: 'running', unverifiable: true, activity: '$ npm test' })]);
    expect(row).toMatchObject({ section: 'needsYou', detailKey: 'fleet.detail.unconfirmed' });
    expect(row.detail).toBeUndefined();
  });

  it('supervision stopped → needsYou with the recovery-stopped detail', () => {
    const row = only([pane('s', { agentStatus: 'idle', supervision: { status: 'stopped', restartCount: 3 } })]);
    expect(row).toMatchObject({ section: 'needsYou', detailKey: 'fleet.detail.supervisionStopped' });
  });

  it('complete → needsYou with the last message, else "Response finished"', () => {
    expect(only([pane('c', { agentStatus: 'complete' })], { surfaceLastMessage: { c: 'All tests pass.' } }))
      .toMatchObject({ section: 'needsYou', detail: 'All tests pass.', detailSource: 'lastMessage' });
    expect(only([pane('c', { agentStatus: 'complete' })])).toMatchObject({ section: 'needsYou', detailKey: 'fleet.detail.complete' });
  });

  it('running → running with the tool activity, else "Turn in progress"', () => {
    expect(only([pane('r', { agentStatus: 'running', activity: '✎ fleet.ts' })]))
      .toMatchObject({ section: 'running', detail: '✎ fleet.ts', detailSource: 'activity' });
    expect(only([pane('r', { agentStatus: 'running', activity: '  ' })])).toMatchObject({ section: 'running', detailKey: 'fleet.detail.running' });
  });

  it('idle → idle with the last message, else "No recent activity reported"', () => {
    expect(only([pane('i')], { surfaceLastMessage: { i: 'Summary.' } })).toMatchObject({ section: 'idle', detail: 'Summary.' });
    expect(only([pane('i')])).toMatchObject({ section: 'idle', detailKey: 'fleet.detail.idle' });
  });

  it('remote rows follow the same rules', () => {
    const row = only([pane('remote:h:s', { agentStatus: 'awaiting_input', surfaceType: 'remote-terminal', remote: { hostId: 'h', hostLabel: 'box' } })]);
    expect(row).toMatchObject({ section: 'needsYou', detailKey: 'fleet.needsYourInput' });
  });
});

describe('groupFleetPanes — elapsed time and ordering', () => {
  const now = 10_000_000;

  it('idleForMs is now minus the NEWEST of activity / output / turn stamps', () => {
    const row = only([pane('a', { agentStatus: 'running' })], {
      now,
      surfaceActivityAt: { a: now - 90_000 },
      surfaceOutputAt: { a: now - 30_000 },
      surfaceTurnOpenAt: { a: now - 600_000 },
    });
    expect(row.idleForMs).toBe(30_000);
  });

  it('a row with no timestamps has no elapsed time (never NaN) and sorts last', () => {
    const g = groupFleetPanes([pane('none'), pane('old'), pane('new')], {
      now,
      surfaceOutputAt: { old: now - 3_600_000, new: now - 60_000 },
    });
    expect(ids(g.idle)).toEqual(['new', 'old', 'none']);
    expect(g.idle[2].idleForMs).toBeUndefined();
    expect(Number.isNaN(g.idle[2].idleForMs)).toBe(false);
  });

  it('within a section: status rank first, then most recent activity first', () => {
    const g = groupFleetPanes([
      pane('c-old', { agentStatus: 'complete' }),
      pane('c-new', { agentStatus: 'complete' }),
      pane('err', { agentStatus: 'error' }),
      pane('ask', { agentStatus: 'awaiting_input' }),
    ], { now, surfaceOutputAt: { 'c-old': now - 7_200_000, 'c-new': now - 60_000, err: now - 1 } });
    expect(ids(g.needsYou)).toEqual(['ask', 'err', 'c-new', 'c-old']);
  });

  it("'workspace' sort mode keeps the input order inside each section", () => {
    const g = groupFleetPanes([pane('b', { agentStatus: 'complete' }), pane('a', { agentStatus: 'awaiting_input' })], {
      sortMode: 'workspace',
    });
    expect(ids(g.needsYou)).toEqual(['b', 'a']);
  });

  it('all-idle fleet: needsYou and running are empty', () => {
    const g = groupFleetPanes([pane('x'), pane('y', { agentStatus: 'waiting' })]);
    expect(g.needsYou).toEqual([]);
    expect(g.running).toEqual([]);
    expect(ids(g.idle)).toEqual(['y', 'x']); // waiting outranks idle
  });
});

describe('groupFleetPanes — Needs you severity and agent text', () => {
  it('orders Needs you by severity: stopped, input, error, unconfirmed, finished', () => {
    const g = groupFleetPanes([
      pane('done', { agentStatus: 'complete' }),
      pane('stale', { agentStatus: 'running', unverifiable: true }),
      pane('err', { agentStatus: 'error' }),
      pane('ask', { agentStatus: 'waiting' }),
      pane('halt', { agentStatus: 'idle', supervision: { status: 'stopped', restartCount: 2 } }),
    ], { surfacePendingQuestion: { ask: 'Continue?' } });
    expect(ids(g.needsYou)).toEqual(['halt', 'ask', 'err', 'stale', 'done']);
  });

  it('flattens bidi / zero-width characters out of a running row\'s activity', () => {
    const row = only([pane('r', { agentStatus: 'running', activity: '✎ src/\u202Egnp.exe\u202C\u200B.ts' })]);
    expect(row.detail).toBe('✎ src/gnp.exe.ts');
  });
});

describe('background tab that needs you (attentionPtyId)', () => {
  const ws: Workspace = {
    id: 'ws-1', name: 'alpha', activePaneId: 'p1',
    rootPane: {
      id: 'p1', type: 'leaf', activeSurfaceId: 's-front',
      surfaces: [
        { id: 's-front', ptyId: 'pty-front', title: 'front', shell: 'zsh', cwd: '/', surfaceType: 'terminal' },
        { id: 's-back', ptyId: 'pty-back', title: 'back', shell: 'zsh', cwd: '/', surfaceType: 'terminal' },
      ],
    },
  };

  it('records the background pty and reads its question for the row detail', () => {
    const state = {
      workspaces: [ws], surfaceAgentStatus: {}, surfaceActivity: {},
      surfacePendingQuestion: { 'pty-back': 'Which region?' },
    };
    const [p] = selectFleetPanes(state);
    expect(p).toMatchObject({ ptyId: 'pty-front', agentStatus: 'awaiting_input', attentionPtyId: 'pty-back' });
    const row = only([p], { surfacePendingQuestion: state.surfacePendingQuestion });
    expect(row).toMatchObject({ section: 'needsYou', detail: 'Which region?', detailSource: 'question' });
  });

  it('leaves attentionPtyId unset when the active tab is the one that needs you', () => {
    const [p] = selectFleetPanes({
      workspaces: [ws], surfaceAgentStatus: { 'pty-front': 'error' }, surfaceActivity: {},
    });
    expect(p.attentionPtyId).toBeUndefined();
  });

  it('keeps the active tab on an equal-rank tie, even when the background tab comes first', () => {
    const backFirst: Workspace = {
      ...ws,
      rootPane: { ...(ws.rootPane as Extract<Workspace['rootPane'], { type: 'leaf' }>), surfaces: [...(ws.rootPane as Extract<Workspace['rootPane'], { type: 'leaf' }>).surfaces].reverse() },
    };
    const [p] = selectFleetPanes({
      workspaces: [backFirst], surfaceAgentStatus: { 'pty-back': 'complete', 'pty-front': 'complete' }, surfaceActivity: {},
    });
    expect(p.agentStatus).toBe('complete');
    expect(p.attentionPtyId).toBeUndefined();
  });
});

describe('selectSurfaceLastMessage', () => {
  it('tolerates an absent map and blank messages', () => {
    expect(selectSurfaceLastMessage({}, 'a')).toBeUndefined();
    expect(selectSurfaceLastMessage({ surfaceLastMessage: { a: '   ' } }, 'a')).toBeUndefined();
    expect(selectSurfaceLastMessage({ surfaceLastMessage: { a: ' hi ' } }, 'a')).toBe('hi');
    expect(selectSurfaceLastMessage({ surfaceLastMessage: { a: 'hi' } }, '')).toBeUndefined();
  });
});
