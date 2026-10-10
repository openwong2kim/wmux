import { describe, expect, it } from 'vitest';
import { liveRecoveryHint } from '../recoveryHint';

describe('liveRecoveryHint', () => {
  const make = () => ({
    hints: new Map<string, string>([['p1', 'claude']]),
    bindings: new Map<string, { sessionId: string }>([['p1', { sessionId: 'x' }]]),
  });

  it('drops a hint and its binding once the pane agent is observed alive', () => {
    const { hints, bindings } = make();
    expect(liveRecoveryHint('p1', () => true, hints, bindings)).toBeUndefined();
    expect(hints.has('p1')).toBe(false);
    expect(bindings.has('p1')).toBe(false);
  });

  it('keeps the hint while liveness is unknown or the agent is not running', () => {
    for (const alive of [undefined, false]) {
      const { hints, bindings } = make();
      expect(liveRecoveryHint('p1', () => alive, hints, bindings)).toBe('claude');
      expect(hints.has('p1')).toBe(true);
      expect(bindings.has('p1')).toBe(true);
    }
  });

  it('returns undefined for a pane that was never flagged', () => {
    const { hints, bindings } = make();
    expect(liveRecoveryHint('p2', () => true, hints, bindings)).toBeUndefined();
    expect(hints.size).toBe(1);
  });
});
