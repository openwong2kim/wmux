// @vitest-environment jsdom
//
// Moa's delegate in the panel: an escalated question (with Moa's suggestion
// and one-click accept), an escalated merge (the head the card shows is the
// head sent; a moved head comes back stale and the card says so), the merge
// activity and the per-rule auto toggles. With the delegate off nothing draws.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MoaDelegateActivity, MoaDelegateTicketRow, laneFailuresOf } from '../MoaDelegateCards';
import { MoaPanelTop } from '../MoaPanelTop';
import { selectAutoRules, selectEffectRows, selectOpenTickets, selectUnreceipted, type MoaDelegateApi } from '../moaDelegateData';
import type { MergeEffect, MoaDecision, MoaDelegateListResult, MoaRuleView } from '../../../../../shared/moaDecision';

let container: HTMLDivElement;
let root: Root;
const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}(${Object.values(vars).join(',')})` : key;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const id = (n: number) => `moa-d-00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function ticket(n: number, over: Partial<MoaDecision> = {}): MoaDecision {
  return {
    id: id(n),
    ticketId: `moa-t-00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    asker: { ptyId: 'pty-1', workspaceId: 'ws-a', agent: 'claude' },
    askKey: 'k'.repeat(64),
    questionHash: 'h'.repeat(32),
    kind: 'question',
    body: { type: 'question', question: 'Which port?', options: [{ key: 'a', label: '3000' }, { key: 'b', label: '8080' }] },
    mode: 'suggest',
    status: 'escalated',
    judge: null,
    ruleId: null,
    reasonCode: 'no-rule',
    why: 'no rule covers it',
    resolvedBy: null,
    createdAt: n,
    resolvedAt: null,
    receipt: 'done',
    ...over,
  };
}

const mergeTicket = (n: number, over: Partial<MoaDecision> = {}): MoaDecision => ticket(n, {
  kind: 'merge',
  body: { type: 'merge', prNumber: 1858, expectHead: HEAD },
  reasonCode: 'lane:required-checks-green',
  why: 'author-trusted failed too',
  ...over,
});

const rule = (ruleId: string, over: Partial<MoaRuleView> = {}): MoaRuleView => ({
  ruleId, text: 'Merge a green PR', autoInBook: true, predicate: 'merge-lane', autoOn: false,
  agreement: { compared: 0, agreed: 0 }, ...over,
});

const effect = (status: MergeEffect['status'], over: Partial<MergeEffect> = {}): MergeEffect => ({
  id: `effect:${id(9)}:pr.merge`, kind: 'pr.merge', decisionId: id(9), repoKey: 'o/r', repoPath: '/r',
  prNumber: 1858, expectHead: HEAD, approvedBy: 'owner', status, attempt: 1, createdAt: 1, updatedAt: 1, ...over,
});

const name = (wsId: string) => (wsId === 'ws-a' ? 'Repo A' : undefined);

describe('question card', () => {
  it('shows the question, Moa\'s suggestion, and accepts it in one click', async () => {
    const resolve = vi.fn(async () => ({ ok: true as const, decision: ticket(1) }));
    const onDone = vi.fn();
    const d = ticket(1, { judge: { verdict: 'answer', choiceKey: 'b', ruleId: 'R-ports', reasonCode: 'rule', why: 'dev servers use 8080', tokens: { input: 1, output: 1 }, ms: 1 } });
    await act(async () => root.render(createElement('ul', null, createElement(MoaDelegateTicketRow, { decision: d, resolve, onDone, workspaceName: name, t }))));
    expect(container.textContent).toContain('Which port?');
    expect(container.textContent).toContain('Repo A · claude');
    const suggestion = container.querySelector('[data-moa-delegate-suggestion]')!.textContent!;
    expect(suggestion).toContain('8080');
    expect(suggestion).toContain('R-ports');
    expect(suggestion).toContain('dev servers use 8080');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-moa-delegate-accept]')!.click(); });
    expect(resolve).toHaveBeenCalledWith({ decisionId: d.id, answer: { type: 'choice', choiceKey: 'b' } });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('has no accept without a suggestion; Not needed dismisses', async () => {
    const resolve = vi.fn(async () => ({ ok: false as const, code: 'not-open' as const, message: 'settled' }));
    const onDone = vi.fn();
    await act(async () => root.render(createElement('ul', null, createElement(MoaDelegateTicketRow, { decision: ticket(2), resolve, onDone, workspaceName: name, t }))));
    expect(container.querySelector('[data-moa-delegate-accept]')).toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-moa-delegate-dismiss]')!.click(); });
    expect(resolve).toHaveBeenCalledWith({ decisionId: id(2), answer: { type: 'dismiss' } });
    // Settled elsewhere a moment before: the row leaves without an error.
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('merge card', () => {
  it('sends the head it shows, and says so when the PR moved (stale)', async () => {
    const resolve = vi.fn(async () => ({ ok: false as const, code: 'stale' as const, message: 'moved' }));
    const onDone = vi.fn();
    const d = mergeTicket(3);
    await act(async () => root.render(createElement('ul', null, createElement(MoaDelegateTicketRow, { decision: d, resolve, onDone, workspaceName: name, t }))));
    expect(container.querySelector('[data-moa-delegate-head]')!.textContent).toBe('0123456');
    expect(container.textContent).toContain('moa.delegate.mergeTitle(1858)');
    const failures = [...container.querySelectorAll('[data-lane-failure]')].map((li) => li.getAttribute('data-lane-failure'));
    expect(failures).toEqual(['required-checks-green', 'author-trusted']);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-moa-delegate-approve]')!.click(); });
    expect(resolve).toHaveBeenCalledWith({ decisionId: d.id, answer: { type: 'merge', approve: true, expectHead: HEAD } });
    expect(onDone).not.toHaveBeenCalled();
    expect(container.querySelector('[data-moa-delegate-notice]')!.getAttribute('data-moa-delegate-notice')).toBe('stale');
    expect(container.textContent).toContain('moa.delegate.stale');
    // The card stays and can still be answered.
    expect(container.querySelector<HTMLButtonElement>('[data-moa-delegate-decline]')!.disabled).toBe(false);
  });

  it('declines with approve:false and the same head', async () => {
    const resolve = vi.fn(async () => ({ ok: true as const, decision: mergeTicket(4) }));
    await act(async () => root.render(createElement('ul', null, createElement(MoaDelegateTicketRow, { decision: mergeTicket(4), resolve, onDone: vi.fn(), workspaceName: name, t }))));
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-moa-delegate-decline]')!.click(); });
    expect(resolve).toHaveBeenCalledWith({ decisionId: id(4), answer: { type: 'merge', approve: false, expectHead: HEAD } });
  });

  it('reads lane predicate ids only as whole tokens', () => {
    expect(laneFailuresOf({ reasonCode: 'x-head-unchanged-y', why: '' })).toEqual([]);
    expect(laneFailuresOf({ reasonCode: 'not-windows-path', why: 'and no-needs-windows-verify-label' })).toEqual(['not-windows-path', 'no-needs-windows-verify-label']);
  });
});

describe('rules and activity', () => {
  it('toggles a rule through main; agreement shows only once compared', async () => {
    const autoSet = vi.fn(async () => ({ ok: true as const, autoRules: ['R-merge-green'] }));
    const onChanged = vi.fn();
    const rules = [rule('R-merge-green'), rule('R-other', { autoOn: true, agreement: { compared: 5, agreed: 4 } })];
    await act(async () => root.render(createElement(MoaDelegateActivity, { effects: [], unreceipted: [], rules, autoSet, onChanged, t })));
    const toggles = container.querySelectorAll<HTMLButtonElement>('[data-moa-delegate-rule-toggle]');
    expect(toggles).toHaveLength(2);
    expect(toggles[0].getAttribute('aria-checked')).toBe('false');
    expect(toggles[1].getAttribute('aria-checked')).toBe('true');
    expect(container.querySelectorAll('[data-moa-delegate-agreement]')).toHaveLength(1);
    expect(container.textContent).toContain('moa.delegate.agreement(4,5)');
    await act(async () => { toggles[0].click(); });
    expect(autoSet).toHaveBeenCalledWith({ ruleId: 'R-merge-green', auto: true });
    expect(onChanged).toHaveBeenCalled();
  });

  it('lists only rules the book marks auto with a known predicate', () => {
    const state: MoaDelegateListResult = {
      mode: 'suggest', decisions: [], effects: [],
      rules: [rule('R-a'), rule('R-b', { autoInBook: false }), rule('R-c', { predicate: null })],
    };
    expect(selectAutoRules(state).map((r) => r.ruleId)).toEqual(['R-a']);
  });

  it('shows effect status and unreceipted merges quietly', async () => {
    await act(async () => root.render(createElement(MoaDelegateActivity, {
      effects: [effect('inFlight')], unreceipted: [effect('uncertain', { id: 'e2', prNumber: 7 })], rules: [], autoSet: vi.fn(), t,
    })));
    expect(container.querySelector('[data-moa-delegate-effect]')!.textContent).toContain('moa.delegate.effect.running');
    expect(container.querySelector('[data-moa-delegate-unreceipted]')!.textContent).toContain('moa.delegate.unreceipted(7,0123456)');
  });
});

describe('selectors', () => {
  const now = 10_000_000_000;
  const state = (mode: MoaDelegateListResult['mode']): MoaDelegateListResult => ({
    mode,
    decisions: [
      ticket(2),
      ticket(1),
      ticket(3, { status: 'answered', resolvedBy: 'owner', resolvedAt: 5 }),
      ticket(4, { resolvedBy: 'expired', resolvedAt: 5 }),
      // main stopped mid-judge: reads as escalated, so the owner may answer it
      ticket(5, { status: 'pending', receipt: 'uncertain' }),
      ticket(6, { status: 'pending', receipt: 'inFlight' }),
    ],
    effects: [effect('done', { id: 'a', updatedAt: now - 1000 }), effect('done', { id: 'old', updatedAt: 1 }), effect('uncertain', { id: 'u', updatedAt: now })],
    rules: [rule('R-a')],
  });

  it('opens only tickets the owner can answer, oldest first', () => {
    expect(selectOpenTickets(state('suggest')).map((d) => d.id)).toEqual([id(1), id(2), id(5)]);
    expect(selectEffectRows(state('auto'), now).map((e) => e.id)).toEqual(['a']);
    expect(selectUnreceipted(state('auto')).map((e) => e.id)).toEqual(['u']);
  });

  it('draws nothing while off or only recording', () => {
    for (const mode of ['off', 'shadow'] as const) {
      const s = state(mode);
      expect(selectOpenTickets(s)).toEqual([]);
      expect(selectEffectRows(s, now)).toEqual([]);
      expect(selectUnreceipted(s)).toEqual([]);
      expect(selectAutoRules(s)).toEqual([]);
    }
  });
});

describe('MoaPanelTop with the delegate', () => {
  const linksApi = { list: async () => [], onChanged: () => () => undefined };
  const approvalsApi = { delegatedApprovals: async () => ({ approvals: [] }) };
  const api = (result: MoaDelegateListResult): MoaDelegateApi => ({
    delegateList: vi.fn(async () => result),
    delegateResolve: vi.fn(async () => ({ ok: true as const, decision: ticket(1) })),
    delegateAutoSet: vi.fn(async () => ({ ok: true as const, autoRules: [] })),
    onDelegateDecision: () => () => undefined,
    onDelegateEffect: () => () => undefined,
  });

  it('off: nothing of the delegate draws', async () => {
    const delegateApi = api({ mode: 'off', decisions: [], effects: [], rules: [] });
    await act(async () => root.render(createElement(MoaPanelTop, { decisions: [], linksApi, approvalsApi, delegateApi, t })));
    expect(container.querySelector('[data-moa-delegate-ticket]')).toBeNull();
    expect(container.querySelector('[data-moa-delegate-activity]')).toBeNull();
    expect(container.querySelector('[data-moa-waiting]')?.className).toBe('hidden');
  });

  it('suggest: an escalated ticket joins Waiting on you and the auto rules draw', async () => {
    const delegateApi = api({ mode: 'suggest', decisions: [ticket(1)], effects: [], rules: [rule('R-a')] });
    await act(async () => root.render(createElement(MoaPanelTop, { decisions: [], linksApi, approvalsApi, delegateApi, t })));
    expect(container.querySelector('[data-moa-waiting] [data-moa-delegate-ticket]')).not.toBeNull();
    expect(container.querySelector('#moa-waiting-title')!.textContent).toContain('1');
    expect(container.querySelector('[data-moa-delegate-rule="R-a"]')).not.toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-moa-delegate-option="a"]')!.click(); });
    expect(delegateApi.delegateResolve).toHaveBeenCalledWith({ decisionId: id(1), answer: { type: 'choice', choiceKey: 'a' } });
    expect(container.querySelector('[data-moa-delegate-ticket]')).toBeNull();
  });
});
