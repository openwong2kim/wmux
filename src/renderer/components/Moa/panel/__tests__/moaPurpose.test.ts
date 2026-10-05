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

  it('a hand-off waits only while its own card (by the id the proposal returned) is up', () => {
    const cards: MoaPendingDecision[] = [{ workspaceId: 'ws-w', decision: { id: 'd9', question: 'Q', options: [], context: '', raisedAt: 1 },
      handoff: { id: 'h2', body: 'b', title: 'Same title', agentName: 'Claude', targetPaneId: 'p', targetPtyId: 't', foldsNewlines: false, willQueue: false } }];
    expect(purposeWaits({ kind: 'handoff', input: { title: 'Same title' }, ok: true, resultId: 'h2' }, cards)).toBe(true);
    // An older proposal with the same title, or one with no id, does not.
    expect(purposeWaits({ kind: 'handoff', input: { title: 'Same title' }, ok: true, resultId: 'h1' }, cards)).toBe(false);
    expect(purposeWaits({ kind: 'handoff', input: {}, ok: true }, cards)).toBe(false);
  });
});
