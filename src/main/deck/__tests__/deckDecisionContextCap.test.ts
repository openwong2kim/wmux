import { describe, expect, it } from 'vitest';
import { DECISION_LIMITS, decisionContextCap } from '../deckDecisionStore';

describe('decisionContextCap', () => {
  it('a Moa goal card gets the larger cap; every other card keeps 800', () => {
    expect(decisionContextCap('moa-goal')).toBe(DECISION_LIMITS.MAX_GOAL_CONTEXT_CHARS);
    expect(DECISION_LIMITS.MAX_GOAL_CONTEXT_CHARS).toBeGreaterThanOrEqual(8000);
    expect(decisionContextCap(undefined)).toBe(800);
    expect(decisionContextCap('brain')).toBe(800);
  });
});
