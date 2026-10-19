import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { liveRecoveryHint, namedAgentAlive } from '../recoveryHint';

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

describe('namedAgentAlive', () => {
  it('answers only for a process attributed to a named agent', () => {
    expect(namedAgentAlive({ slug: 'claude', alive: true })).toBe(true);
    expect(namedAgentAlive({ slug: 'claude', alive: false })).toBe(false);
    // A slugless pick: `tail -f` printing a quoted banner is not an agent.
    expect(namedAgentAlive({ alive: true })).toBeUndefined();
    expect(namedAgentAlive(undefined)).toBeUndefined();
  });

  it('the daemon consumes recovery hints on named-agent liveness only', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');
    const calls = src.match(/liveRecoveryHint\([^,]+, \([^)]*\) => [^,]+,/g) ?? [];
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call).toMatch(/namedAgentAlive\(agentProcessTracker\.identityFor\(/);
  });
});
