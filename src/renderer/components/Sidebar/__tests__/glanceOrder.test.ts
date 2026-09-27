// Glance board (2026-09-25): order by class and recency, new-workspace hold,
// and the pinned group leading every order (2026-09-26).
import { describe, expect, it } from 'vitest';
import { boardOrder, glanceOrder, reconcileAppliedOrder, NEW_WORKSPACE_HOLD_MS } from '../glanceOrder';
import { movePinned } from '../../../utils/sidebarLayout';
import { ATTENTION_CLASS_RANK as R, attentionScore, remoteWorkspaceAttentionScore } from '../../../stores/selectors/fleet';
import type { RemotePaneSummary } from '../../../../shared/remoteHosts';

const ws = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (list: { id: string }[]) => list.map((w) => w.id);

describe('glanceOrder', () => {
  const scores: Record<string, number> = {
    idle: attentionScore(R.idle, 0),
    run: attentionScore(R.running, 100),
    unconf: attentionScore(R.unconfirmed, 100),
    done: attentionScore(R.finished, 100),
    needOld: attentionScore(R.needsYou, 100),
    needNew: attentionScore(R.needsYou, 200),
  };
  const scoreOf = (id: string) => scores[id];

  it('orders needs you → finished → running → unconfirmed → idle, newest first within a class', () => {
    const out = glanceOrder(ws('idle', 'run', 'unconf', 'done', 'needOld', 'needNew'), scoreOf, {}, 0);
    expect(ids(out)).toEqual(['needNew', 'needOld', 'done', 'run', 'unconf', 'idle']);
  });

  it('holds a just-created workspace on top, then lets it sort normally', () => {
    const newAt = { idle: 1_000 };
    expect(ids(glanceOrder(ws('needNew', 'idle'), scoreOf, newAt, 1_000 + 60_000))).toEqual(['idle', 'needNew']);
    expect(ids(glanceOrder(ws('needNew', 'idle'), scoreOf, newAt, 1_000 + NEW_WORKSPACE_HOLD_MS))).toEqual(['needNew', 'idle']);
  });
});

describe('boardOrder — pinned group first', () => {
  const scores: Record<string, number> = {
    idle: attentionScore(R.idle, 0),
    run: attentionScore(R.running, 100),
    needNew: attentionScore(R.needsYou, 200),
    pinIdle: attentionScore(R.idle, 0),
    pinNeed: attentionScore(R.needsYou, 300),
  };
  const base = {
    scoreOf: (id: string) => scores[id],
    activityOf: (id: string) => ({ idle: 1, run: 5, needNew: 3, pinIdle: 0, pinNeed: 9 } as Record<string, number>)[id],
    newAt: {},
    now: 0,
  };
  // Stored order keeps pinned rows as a prefix.
  const manual = ws('pinIdle', 'pinNeed', 'idle', 'run', 'needNew');
  const pinned = new Set(['pinIdle', 'pinNeed']);
  const flat = (o: { pinned: { id: string }[]; rest: { id: string }[] }) => [...ids(o.pinned), ...ids(o.rest)];

  it('shows the pinned group first, as stored, in manual mode', () => {
    expect(flat(boardOrder({ ...base, manual, pinned, mode: 'manual' }))).toEqual(['pinIdle', 'pinNeed', 'idle', 'run', 'needNew']);
  });

  it('re-sorts only below the pinned group in attention mode', () => {
    const out = boardOrder({ ...base, manual, pinned, mode: 'attention' });
    // pinNeed needs you more than anything, yet stays behind pinIdle inside the group.
    expect(ids(out.pinned)).toEqual(['pinIdle', 'pinNeed']);
    expect(ids(out.rest)).toEqual(['needNew', 'run', 'idle']);
  });

  it('re-sorts only below the pinned group in recent mode', () => {
    expect(flat(boardOrder({ ...base, manual, pinned, mode: 'recent' }))).toEqual(['pinIdle', 'pinNeed', 'run', 'needNew', 'idle']);
  });

  it('a new workspace holds the top of the rest, not above the pins', () => {
    const out = boardOrder({ ...base, manual: [...manual, { id: 'fresh' }], pinned, mode: 'attention', newAt: { fresh: 1_000 }, now: 2_000 });
    expect(flat(out).slice(0, 3)).toEqual(['pinIdle', 'pinNeed', 'fresh']);
  });

  it('follows a reorder inside the group in every mode', () => {
    const moved = movePinned(manual, [...pinned], 1, 0, true);
    expect(moved).not.toBeNull();
    for (const mode of ['manual', 'attention', 'recent'] as const) {
      expect(ids(boardOrder({ ...base, manual: moved!.items, pinned, mode }).pinned)).toEqual(['pinNeed', 'pinIdle']);
    }
  });

  it('keeps a nested fan-out task out of the group (it renders under its owner)', () => {
    const out = boardOrder({ ...base, manual: [...manual, { id: 'task' }], pinned: new Set([...pinned, 'task']), mode: 'attention', nestedOwnerOf: (id) => (id === 'task' ? 'run' : undefined) });
    expect(ids(out.pinned)).toEqual(['pinIdle', 'pinNeed']);
    expect(ids(out.rest)).toContain('task');
  });
});

describe('boardOrder — attached remote rows join the list', () => {
  const agent = (agentStatus: RemotePaneSummary['agentStatus']): RemotePaneSummary => ({ sessionId: 's', agentName: 'Claude Code', agentStatus });
  const remoteScores: Record<string, number> = {
    'remote:ask': remoteWorkspaceAttentionScore({ panes: [agent('idle'), agent('awaiting_input')] }),
    'remote:staleAsk': remoteWorkspaceAttentionScore({ panes: [agent('awaiting_input')], stale: true }),
    'remote:refused': remoteWorkspaceAttentionScore({ panes: [agent('error')], stale: true, authRejected: true }),
  };
  const scores: Record<string, number> = {
    pin: attentionScore(R.idle, 0),
    idle: attentionScore(R.idle, 0),
    run: attentionScore(R.running, 100),
  };
  const remote = ws('remote:ask', 'remote:staleAsk', 'remote:refused');
  const base = {
    manual: ws('pin', 'idle', 'run'),
    pinned: new Set(['pin']),
    scoreOf: (id: string) => scores[id],
    activityOf: (id: string) => ({ idle: 1, run: 5 } as Record<string, number>)[id],
    newAt: {},
    now: 0,
    remote,
    remoteScoreOf: (id: string) => remoteScores[id],
  };

  it('scores a remote workspace by its most urgent agent pane, on the local scale', () => {
    expect(remoteScores['remote:ask']).toBe(attentionScore(R.needsYou, 0));
    // A pane with no agent name is not an agent, whatever status it carries.
    expect(remoteWorkspaceAttentionScore({ panes: [{ sessionId: 's', agentStatus: 'awaiting_input' }] })).toBe(attentionScore(R.idle, 0));
  });

  it('interleaves by attention: a remote that needs you sorts above idle local rows; a stale one falls to idle', () => {
    const out = boardOrder({ ...base, mode: 'attention' });
    expect(ids(out.pinned)).toEqual(['pin']);
    expect(ids(out.rest)).toEqual(['remote:ask', 'run', 'idle', 'remote:staleAsk', 'remote:refused']);
  });

  it('puts remote rows after every local row, in attach order, in manual and recent', () => {
    expect(ids(boardOrder({ ...base, mode: 'manual' }).rest)).toEqual(['idle', 'run', 'remote:ask', 'remote:staleAsk', 'remote:refused']);
    expect(ids(boardOrder({ ...base, mode: 'recent' }).rest)).toEqual(['run', 'idle', 'remote:ask', 'remote:staleAsk', 'remote:refused']);
  });

  it('holds the on-screen order when a remote row becomes urgent (settle rule)', () => {
    const before = ids(boardOrder({ ...base, remote: ws('remote:quiet'), remoteScoreOf: () => attentionScore(R.idle, 0), mode: 'attention' }).rest);
    expect(before).toEqual(['run', 'idle', 'remote:quiet']);
    const after = ids(boardOrder({ ...base, remote: ws('remote:quiet'), remoteScoreOf: () => attentionScore(R.needsYou, 0), mode: 'attention' }).rest);
    expect(reconcileAppliedOrder(before, after)).toEqual({ order: before, pending: true });
  });
});

describe('reconcileAppliedOrder', () => {
  it('keeps the order on screen and reports a pending re-sort', () => {
    expect(reconcileAppliedOrder(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual({ order: ['a', 'b', 'c'], pending: true });
  });
  it('absorbs removals and additions at once', () => {
    expect(reconcileAppliedOrder(['a', 'b', 'c'], ['new', 'a', 'c'])).toEqual({ order: ['new', 'a', 'c'], pending: false });
  });
});
