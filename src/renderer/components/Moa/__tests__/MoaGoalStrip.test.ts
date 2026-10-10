import { describe, expect, it } from 'vitest';
import { goalStripVisible } from '../MoaGoalStrip';
import type { MoaGoalPanel } from '../../../../shared/moa';

const g = (over: Partial<MoaGoalPanel>): MoaGoalPanel => ({
  id: 'G-abc123', status: 'active', goal: 'g', repoRoot: '/r', tasksUsed: 0, maxTasks: 4, turnsUsed: 0, maxTurns: 40, live: true, ...over,
});

describe('goalStripVisible', () => {
  it('shows open goals and goals that ended in the last day', () => {
    expect(goalStripVisible(null, 0)).toBe(false);
    expect(goalStripVisible(g({ status: 'pending' }), 0)).toBe(true);
    expect(goalStripVisible(g({ status: 'active' }), 0)).toBe(true);
    expect(goalStripVisible(g({ status: 'completed', endedAt: 1000 }), 1000 + 60_000)).toBe(true);
    expect(goalStripVisible(g({ status: 'completed', endedAt: 1000 }), 1000 + 25 * 3_600_000)).toBe(false);
    expect(goalStripVisible(g({ status: 'canceled' }), 0)).toBe(false);
  });
});
