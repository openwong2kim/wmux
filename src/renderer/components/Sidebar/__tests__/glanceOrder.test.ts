// Glance board (2026-09-25): order by class and recency, pins, new-workspace hold.
import { describe, expect, it } from 'vitest';
import { glanceOrder, reconcileAppliedOrder, NEW_WORKSPACE_HOLD_MS } from '../glanceOrder';
import { ATTENTION_CLASS_RANK as R, attentionScore } from '../../../stores/selectors/fleet';

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
    const out = glanceOrder(ws('idle', 'run', 'unconf', 'done', 'needOld', 'needNew'), scoreOf, new Set(), {}, 0);
    expect(ids(out)).toEqual(['needNew', 'needOld', 'done', 'run', 'unconf', 'idle']);
  });

  it('keeps a pinned workspace at its manual position', () => {
    const out = glanceOrder(ws('idle', 'run', 'needNew'), scoreOf, new Set(['idle']), {}, 0);
    expect(ids(out)).toEqual(['idle', 'needNew', 'run']);
  });

  it('holds a just-created workspace on top, then lets it sort normally', () => {
    const newAt = { idle: 1_000 };
    expect(ids(glanceOrder(ws('needNew', 'idle'), scoreOf, new Set(), newAt, 1_000 + 60_000))).toEqual(['idle', 'needNew']);
    expect(ids(glanceOrder(ws('needNew', 'idle'), scoreOf, new Set(), newAt, 1_000 + NEW_WORKSPACE_HOLD_MS))).toEqual(['needNew', 'idle']);
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
