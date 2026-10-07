import { describe, it, expect } from 'vitest';
import { serveTurnFailure } from '../serveTurnFailure';
import { classifyClaudeStopFailure, turnFailureKey, type TurnFailure } from '../../../shared/phoneTurnFailure';
import { buildTurnFailedPushPayload, turnFailedPushCollapseId, TURN_FAILED_KIND } from '../../push/turnFailedPushPayload';
import { deriveAgentLiveness } from '../../hooks/agentLiveness';

/** A bridge-shaped holder with the same dedup rule as `DaemonPTYBridge.noteTurnFailure`. */
function holder(turnId?: string, at: (ts: number) => { turnId?: string; current: boolean } | null = () => ({ ...(turnId ? { turnId } : {}), current: true })) {
  let held: TurnFailure | undefined;
  return {
    held: () => held,
    turnAt: at,
    noteTurnFailure(failure: TurnFailure) {
      if (held && held.turnId === failure.turnId) return { failure: held, fresh: false };
      held = failure;
      return { failure, fresh: true };
    },
  };
}

describe('serveTurnFailure', () => {
  it('stamps the turn id and hands one object to every surface, pushing once', () => {
    const h = holder('t1:abc.3');
    const pushed: TurnFailure[] = [];
    const payload = { error: 'rate_limit', last_assistant_message: 'You hit your limit · resets 3pm', error_details: 'raw 429 body' };
    const first = serveTurnFailure(h, classifyClaudeStopFailure(payload, 1000), { ts: 1000, push: (f) => pushed.push(f) })!.failure;
    // A repeat delivery later keeps the first `at`: identical on every surface.
    const again = serveTurnFailure(h, classifyClaudeStopFailure(payload, 2000), { ts: 1000, push: (f) => pushed.push(f) })!;
    expect(again).toEqual({ failure: first, current: true });
    expect(again.failure).toBe(first);
    expect(pushed).toEqual([first]);
    expect(first).toEqual({ reason: 'rate-limited', provider: 'claude', providerCode: 'rate_limit',
      message: 'You hit your limit · resets 3pm', at: 1000, turnId: 't1:abc.3' });

    // The liveness frame, the push and the client dedup key all agree.
    const frame = { ...deriveAgentLiveness('s1', { agent: 'Claude Code', status: 'error' }, first.at), failure: first };
    const push = buildTurnFailedPushPayload('s1', first);
    expect(frame).toMatchObject({ state: 'idle', at: 1000, failure: { turnId: 't1:abc.3', at: 1000 } });
    expect(turnFailureKey('s1', { turnId: push.turnId as string, at: push.at as number })).toBe(turnFailureKey('s1', frame.failure));
  });

  it('sends no turn id before the pane has had an episode', () => {
    const f = serveTurnFailure(holder(undefined), classifyClaudeStopFailure({ error: 'billing_error' }, 5), { ts: 5 })!.failure;
    expect(f).toEqual({ reason: 'quota', provider: 'claude', providerCode: 'billing_error', at: 5 });
  });
});

describe('serveTurnFailure — a late delivery', () => {
  it('stamps the turn it ended, and neither holds nor pushes it when the next turn already opened', () => {
    const h = holder(undefined, (ts) => (ts >= 500 ? { turnId: 't1:n.2', current: true } : ts >= 100 ? { turnId: 't1:n.1', current: false } : null));
    const pushed: TurnFailure[] = [];
    const late = serveTurnFailure(h, classifyClaudeStopFailure({ error: 'rate_limit' }, 900), { ts: 300, push: (f) => pushed.push(f) });
    expect(late).toEqual({ failure: { reason: 'rate-limited', provider: 'claude', providerCode: 'rate_limit', at: 900, turnId: 't1:n.1' }, current: false });
    expect(h.held()).toBeUndefined();
    expect(pushed).toEqual([]);
    // Older than both episodes: dropped.
    expect(serveTurnFailure(h, classifyClaudeStopFailure({ error: 'rate_limit' }, 900), { ts: 50 })).toBeUndefined();
  });
});

describe('turn_failed push payload', () => {
  it('carries the exact fields and never the provider message', () => {
    const payload = buildTurnFailedPushPayload('daemon-1', {
      reason: 'auth', provider: 'codex', providerCode: 'unauthorized', httpStatus: 401, message: 'secret-ish text', at: 42, turnId: 't1:n.1',
    });
    expect(payload).toEqual({
      title: 'Turn failed', body: 'The agent could not sign in and stopped.', sessionId: 'daemon-1',
      kind: TURN_FAILED_KIND, turnId: 't1:n.1', at: 42, reason: 'auth', provider: 'codex',
    });
    expect(JSON.stringify(payload)).not.toContain('secret-ish');
    expect(buildTurnFailedPushPayload('s', { reason: 'unknown', provider: 'claude', at: 1 })).not.toHaveProperty('turnId');
    expect(turnFailedPushCollapseId('daemon-1')).toBe('tf-daemon-1');
  });
});
