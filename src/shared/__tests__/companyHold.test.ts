import { describe, it, expect } from 'vitest';

import { COMPANY_BRIEF_KIND } from '../company';
import {
  COMPANY_BLOCKED_BY_REFUSAL,
  COMPANY_BLOCKERS_MAX,
  companyBlockerEndedLine,
  companyBriefOfHistory,
  companyHoldAtCreate,
  companyHoldOf,
  companyHoldPhase,
  companyHoldWithholds,
  companyWaitingLine,
  companyWaitingRefusal,
  isCompanyHoldReason,
} from '../companyHold';
import type { Message, TaskState } from '../types';

const states: Record<string, TaskState> = { open: 'working', done: 'completed', broke: 'failed', dropped: 'canceled' };
const stateOf = (id: string): TaskState | undefined => states[id];

describe('companyHoldAtCreate', () => {
  it('dedupes the blockers in the order asked and drops the completed ones', () => {
    expect(companyHoldAtCreate({ blockedBy: ['open', 'done', 'open', 'ghost'] }, stateOf)).toEqual({
      blockedBy: ['open', 'done', 'ghost'],
      waitingOn: ['open', 'ghost'],
    });
  });

  it('holds nothing when every blocker is completed, or there are none', () => {
    expect(companyHoldAtCreate({ blockedBy: ['done', 'done'] }, stateOf)).toBeNull();
    expect(companyHoldAtCreate({ blockedBy: [] }, stateOf)).toBeNull();
    expect(companyHoldAtCreate({}, stateOf)).toBeNull();
    expect(companyHoldAtCreate(null, stateOf)).toBeNull();
  });

  it('notes blockers that already ended without completing', () => {
    expect(companyHoldAtCreate({ blockedBy: ['broke', 'dropped', 'open'] }, stateOf)).toEqual({
      blockedBy: ['broke', 'dropped', 'open'],
      waitingOn: ['broke', 'dropped', 'open'],
      blockerEnded: [{ id: 'broke', state: 'failed' }, { id: 'dropped', state: 'canceled' }],
    });
  });

  it('with a release time (a send held for its blockers): kept and released when every blocker completed', () => {
    expect(companyHoldAtCreate({ blockedBy: ['done', 'done'] }, stateOf, 't0')).toEqual({ blockedBy: ['done'], waitingOn: [], releasedAt: 't0' });
    expect(companyHoldAtCreate({ blockedBy: ['done', 'open'] }, stateOf, 't0')).toEqual({ blockedBy: ['done', 'open'], waitingOn: ['open'] });
    expect(companyHoldAtCreate({ blockedBy: [] }, stateOf, 't0')).toBeNull();
  });

  it('skips empty ids', () => {
    expect(companyHoldAtCreate({ blockedBy: ['', 'open'] }, stateOf)).toEqual({ blockedBy: ['open'], waitingOn: ['open'] });
  });
});

describe('companyBriefOfHistory', () => {
  const brief = { kind: COMPANY_BRIEF_KIND, v: 1, goal: 'g', scope: 's', acceptance: 'a', verify: 'v', report: 'r', blockedBy: ['x'] };
  const msg = (data: Record<string, unknown>): Message => ({ kind: 'message', messageId: 'm', role: 'user', parts: [{ kind: 'text', text: 'hi' }, { kind: 'data', data }] });

  it('reads the complete brief of the first message', () => {
    expect(companyBriefOfHistory([msg(brief)])?.blockedBy).toEqual(['x']);
  });

  it('is null for an incomplete brief, no brief, or no history', () => {
    expect(companyBriefOfHistory([msg({ ...brief, goal: '' })])).toBeNull();
    expect(companyBriefOfHistory([msg({ kind: 'other' })])).toBeNull();
    expect(companyBriefOfHistory([])).toBeNull();
  });
});

describe('companyHoldOf / companyHoldPhase', () => {
  it('reads only a well-formed marker', () => {
    expect(companyHoldOf({ metadata: { companyHold: { blockedBy: ['a'], waitingOn: [] } } } as never)).toEqual({ blockedBy: ['a'], waitingOn: [] });
    expect(companyHoldOf({ metadata: { companyHold: { blockedBy: 'a', waitingOn: [] } } } as never)).toBeUndefined();
    expect(companyHoldOf({ metadata: {} } as never)).toBeUndefined();
    expect(companyHoldOf(undefined)).toBeUndefined();
  });

  it('waiting, owed (attempted too), delivered, held', () => {
    expect(companyHoldPhase({ blockedBy: ['a'], waitingOn: ['a'] })).toBe('waiting');
    expect(companyHoldPhase({ blockedBy: ['a'], waitingOn: [], releasedAt: 't' })).toBe('owed');
    expect(companyHoldPhase({ blockedBy: ['a'], waitingOn: [], releasedAt: 't', attempted: true })).toBe('owed');
    expect(companyHoldPhase({ blockedBy: ['a'], waitingOn: [], releasedAt: 't', delivered: true })).toBe('delivered');
    expect(companyHoldPhase({ blockedBy: ['a'], waitingOn: [], releasedAt: 't', held: 'no-agent' })).toBe('held');
  });
});

describe('texts', () => {
  it('names the limit, the blocker and the way out', () => {
    expect(COMPANY_BLOCKED_BY_REFUSAL.tooMany(9)).toContain(`at most ${COMPANY_BLOCKERS_MAX}`);
    expect(COMPANY_BLOCKED_BY_REFUSAL.ended('t-1', 'canceled')).toContain('t-1, which was canceled');
    expect(companyWaitingLine(['12', '13'], (id) => `#${id}`)).toBe('Waiting on #12, #13');
    expect(companyBlockerEndedLine('C', { id: 'A', state: 'failed' })).toMatch(/^C stays on hold: its blocker A failed/);
    expect(isCompanyHoldReason('delivery-unconfirmed')).toBe(true);
    expect(isCompanyHoldReason('occupant-changed')).toBe(false);
  });
});

describe('companyHoldWithholds', () => {
  const task = (hold: unknown, from = { workspaceId: 'ws', paneId: 'ceo' }, to = { workspaceId: 'ws', paneId: 's1' }) =>
    ({ metadata: { title: 't', from: { ...from, name: 'n' }, to: { ...to, name: 'n' }, createdAt: '', updatedAt: '', companyHold: hold } }) as never;
  const waiting = { blockedBy: ['a'], waitingOn: ['a'] };

  it('keeps a waiting task from its receiving side only', () => {
    expect(companyHoldWithholds(task(waiting), { workspaceId: 'ws', paneId: 's1' })).toBe(true);
    expect(companyHoldWithholds(task(waiting), { workspaceId: 'ws' })).toBe(true);
    expect(companyHoldWithholds(task(waiting), { workspaceId: 'ws', paneId: 'ceo' })).toBe(false);
    expect(companyHoldWithholds(task(waiting), { workspaceId: 'ws', paneId: 's1', trusted: true })).toBe(false);
    expect(companyHoldWithholds(task(waiting, { workspaceId: 'ws-out', paneId: 'o' }), { workspaceId: 'ws-out' })).toBe(false);
    expect(companyHoldWithholds(task(waiting, { workspaceId: 'ws-out', paneId: 'o' }), { workspaceId: 'ws', paneId: 's1' })).toBe(true);
  });

  it('keeps nothing once released, or without a hold', () => {
    expect(companyHoldWithholds(task({ blockedBy: ['a'], waitingOn: [], releasedAt: 't' }), { workspaceId: 'ws', paneId: 's1' })).toBe(false);
    expect(companyHoldWithholds(task(undefined), { workspaceId: 'ws', paneId: 's1' })).toBe(false);
  });

  it('names the blockers by their short ids', () => {
    expect(companyWaitingRefusal(['task-abcdef123', 'task-99887766x'])).toBe('this task waits on abcdef12, 99887766; it is not yours until they complete');
  });
});
