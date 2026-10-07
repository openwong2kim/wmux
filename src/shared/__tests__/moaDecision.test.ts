import { describe, it, expect } from 'vitest';
import {
  mergeEffectId,
  parseMoaAutoRuleSetRequest,
  parseMoaResolveRequest,
  sanitizeAutoRules,
  ticketView,
  type MergeEffect,
  type MoaDecision,
} from '../moaDecision';

const D_ID = 'moa-d-0b8a6c1e-2f3d-4a5b-9c8d-7e6f5a4b3c2d';
const T_ID = 'moa-t-0b8a6c1e-2f3d-4a5b-9c8d-7e6f5a4b3c2d';
const HEAD = '995e9d9a3124628f51c0a3989bf2eced7ea2f97c';

function decision(over: Partial<MoaDecision> = {}): MoaDecision {
  return {
    id: D_ID,
    ticketId: T_ID,
    asker: { ptyId: 'pty-1', workspaceId: 'ws-1', agent: 'claude' },
    askKey: 'a'.repeat(64),
    questionHash: 'b'.repeat(32),
    kind: 'question',
    body: { type: 'question', question: 'q?', options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }] },
    mode: 'auto',
    status: 'pending',
    judge: null,
    ruleId: null,
    reasonCode: 'judging',
    why: '',
    resolvedBy: null,
    createdAt: 1000,
    resolvedAt: null,
    receipt: 'inFlight',
    ...over,
  };
}

describe('ticketView', () => {
  it('pending carries a poll hint and no answer', () => {
    expect(ticketView(decision())).toMatchObject({ ticketId: T_ID, status: 'pending', pollAfterMs: 3000 });
    expect(ticketView(decision()).answer).toBeUndefined();
  });

  it('a restart mid-judge reads as escalated, restart-uncertain', () => {
    expect(ticketView(decision({ receipt: 'uncertain' }))).toMatchObject({ status: 'escalated', reasonCode: 'restart-uncertain' });
  });

  it('an auto answer names the rule; an owner answer does not', () => {
    const auto = decision({ status: 'answered', receipt: 'done', resolvedBy: 'moa-auto', ruleId: 'R-x', reasonCode: 'rule_match', why: 'w', answer: { choiceKey: '1' }, resolvedAt: 2000 });
    expect(ticketView(auto).answer).toEqual({ choiceKey: '1', ruleId: 'R-x', reasonCode: 'rule_match', why: 'w', resolvedBy: 'moa-auto' });
    const owner = decision({ status: 'answered', receipt: 'done', resolvedBy: 'owner', ruleId: 'R-x', reasonCode: 'owner-approved', answer: { actionVerdict: 'go' }, resolvedAt: 2000 });
    expect(ticketView(owner).answer).toEqual({ actionVerdict: 'go', ruleId: null, reasonCode: 'owner-approved', why: '', resolvedBy: 'owner' });
  });

  it('an expired escalation still reads as escalated', () => {
    expect(ticketView(decision({ status: 'escalated', receipt: 'done', resolvedBy: 'expired', resolvedAt: 9 })).status).toBe('escalated');
  });

  it('shows a merge effect\'s state', () => {
    const effect = { status: 'refused', reason: 'head-moved' } as MergeEffect;
    expect(ticketView(decision({ kind: 'merge' }), effect).effect).toEqual({ status: 'refused', reason: 'head-moved' });
  });

  it('effect ids follow the decision', () => {
    expect(mergeEffectId(D_ID)).toBe(`effect:${D_ID}:pr.merge`);
  });
});

describe('owner IPC validators', () => {
  it('parses each resolve answer and nothing more', () => {
    expect(parseMoaResolveRequest({ decisionId: D_ID, answer: { type: 'choice', choiceKey: '2' } })).toEqual({ ok: true, value: { decisionId: D_ID, answer: { type: 'choice', choiceKey: '2' } } });
    expect(parseMoaResolveRequest({ decisionId: D_ID, answer: { type: 'merge', approve: true, expectHead: HEAD } }).ok).toBe(true);
    expect(parseMoaResolveRequest({ decisionId: D_ID, answer: { type: 'dismiss' } }).ok).toBe(true);
    for (const bad of [
      null,
      { decisionId: T_ID, answer: { type: 'dismiss' } },
      { decisionId: D_ID, answer: { type: 'dismiss', note: 'x' } },
      { decisionId: D_ID, answer: { type: 'merge', approve: 'yes', expectHead: HEAD } },
      { decisionId: D_ID, answer: { type: 'merge', approve: true } },
      { decisionId: D_ID, answer: { type: 'choice', choiceKey: '' } },
      { decisionId: D_ID, answer: { type: 'press', choiceKey: '1' } },
      { decisionId: D_ID, answer: { type: 'dismiss' }, by: 'agent' },
    ]) expect(parseMoaResolveRequest(bad).ok, JSON.stringify(bad)).toBe(false);
  });

  it('parses the per-rule auto toggle', () => {
    expect(parseMoaAutoRuleSetRequest({ ruleId: 'R-merge-green', auto: true })).toEqual({ ok: true, value: { ruleId: 'R-merge-green', auto: true } });
    expect(parseMoaAutoRuleSetRequest({ ruleId: 'merge-green', auto: true }).ok).toBe(false);
    expect(parseMoaAutoRuleSetRequest({ ruleId: 'R-x', auto: 'true' }).ok).toBe(false);
  });

  it('sanitizes stored toggles', () => {
    expect(sanitizeAutoRules(['R-b', 'R-a', 'R-b', 'bad', 3])).toEqual(['R-a', 'R-b']);
    expect(sanitizeAutoRules('R-a')).toEqual([]);
  });
});
