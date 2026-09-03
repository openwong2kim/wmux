import { describe, expect, it } from 'vitest';
import {
  LEDGER_STATUSES,
  LEDGER_TRANSITIONS,
  WORKER_SETTABLE_STATUSES,
  canTransition,
  isLedgerStatus,
} from '../ledger';

describe('ledger vocabulary', () => {
  it('reserves completed for the brain and reaches it only from review_requested', () => {
    expect(WORKER_SETTABLE_STATUSES).not.toContain('completed');
    expect(WORKER_SETTABLE_STATUSES).not.toContain('cancelled');
    const sources = LEDGER_STATUSES.filter((s) => canTransition(s, 'completed'));
    expect(sources).toEqual(['review_requested']);
  });

  it('keeps completed and cancelled terminal, and every status in the transition table', () => {
    expect(LEDGER_TRANSITIONS.completed).toEqual([]);
    expect(LEDGER_TRANSITIONS.cancelled).toEqual([]);
    for (const s of LEDGER_STATUSES) expect(Object.keys(LEDGER_TRANSITIONS)).toContain(s);
    expect(isLedgerStatus('review_requested')).toBe(true);
    expect(isLedgerStatus('done')).toBe(false);
    expect(canTransition('done', 'working')).toBe(false);
    expect(canTransition('working', 'done')).toBe(false);
  });
});
