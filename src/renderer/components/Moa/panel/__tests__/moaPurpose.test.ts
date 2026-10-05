import { describe, expect, it } from 'vitest';
import { purposeWaits, type MoaPurpose } from '../MoaPurposeCard';
import type { MoaPendingDecision } from '../../../../../shared/moa';

const pending: MoaPendingDecision[] = [{ workspaceId: 'ws-hq', decision: { id: 'd1', question: 'Q', options: [], context: '', raisedAt: 1 } }];

describe('purposeWaits', () => {
  it('a decision waits while Waiting on you still lists its id; a failed call never waits', () => {
    const asked: MoaPurpose = { kind: 'decision', input: {}, ok: true, resultId: 'd1' };
    expect(purposeWaits(asked, pending)).toBe(true);
    expect(purposeWaits(asked, [])).toBe(false);
    expect(purposeWaits({ ...asked, ok: false }, pending)).toBe(false);
  });
});
