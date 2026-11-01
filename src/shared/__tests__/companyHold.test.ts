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
  companyWaitingLine,
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
