import { describe, it, expect } from 'vitest';
// The bridge is plain .mjs (Kiro spawns it directly); it exports the pure
// envelope builder so this test can validate the shape without a live kiro-cli.
import { buildKiroEnvelope, shouldTryNextTarget } from '../bin/wmux-kiro-bridge.mjs';
import { isAgentSignal } from '../../shared/signal-types';

// The payloads below are the ones kiro-cli 2.15.1 actually sends, captured live
// (2026-08-16). Notably: no session id anywhere, and both carry raw content.
const STOP_PAYLOAD = {
  hook_event_name: 'stop',
  cwd: 'C:\\work\\proj',
  assistant_response: 'here is the answer, at length',
};
const PROMPT_PAYLOAD = {
  hook_event_name: 'userPromptSubmit',
  cwd: 'C:\\work\\proj',
  prompt: 'the user typed this',
};

const baseEnv = {
  WMUX_PTY_ID: 'pty-123',
  WMUX_WORKSPACE_ID: 'ws-abc',
  WMUX_SURFACE_ID: 'surf-9',
} as NodeJS.ProcessEnv;

describe('buildKiroEnvelope', () => {
  it('maps stop to a canonical agent.stop envelope', () => {
    expect(buildKiroEnvelope(STOP_PAYLOAD, { env: baseEnv, now: 42 })).toEqual({
      kind: 'agent.stop',
      agent: 'kiro',
      ptyId: 'pty-123',
      workspaceId: 'ws-abc',
      surfaceId: 'surf-9',
      cwd: 'C:\\work\\proj',
      payload: {},
      ts: 42,
    });
  });

  it('maps agentSpawn to agent.session_start', () => {
    const envelope = buildKiroEnvelope(
      { hook_event_name: 'agentSpawn', cwd: '/proj' },
      { env: baseEnv, now: 1 },
    );
    expect(envelope?.kind).toBe('agent.session_start');
  });

  it('produces an envelope the wmux daemon accepts', () => {
    expect(isAgentSignal(buildKiroEnvelope(STOP_PAYLOAD, { env: baseEnv, now: 1 }))).toBe(true);
  });

  // The privacy contract. Kiro hands us the user's whole prompt and the model's
  // whole reply; wmux's bridges are metadata-only, so neither may survive into
  // anything we send. Asserted on the serialized envelope, not field-by-field,
  // so a future field that happens to carry content fails this too.
  it('never carries the user prompt or the assistant reply', () => {
    const serialized = JSON.stringify(buildKiroEnvelope(STOP_PAYLOAD, { env: baseEnv, now: 1 }));
    expect(serialized).not.toContain('here is the answer');
    expect(serialized).not.toContain('assistant_response');
    expect(buildKiroEnvelope(STOP_PAYLOAD, { env: baseEnv, now: 1 })?.payload).toEqual({});
  });

  // Kiro sends no session id, so WMUX_PTY_ID is the ONLY thing that can
  // attribute a signal to a pane. With none, dropping beats guessing —
  // attaching a turn boundary to the wrong pane is worse than losing it.
  it('drops the signal when the pane cannot be identified', () => {
    expect(buildKiroEnvelope(STOP_PAYLOAD, { env: {}, now: 1 })).toBeNull();
    expect(buildKiroEnvelope(STOP_PAYLOAD, { env: { WMUX_PTY_ID: '' }, now: 1 })).toBeNull();
  });

  // userPromptSubmit exists in kiro and is deliberately NOT mapped: Kiro has no
  // approval-specific event, and calling "a prompt was submitted" awaiting_input
  // is the conflation #898 punished. Pinning it keeps a later "while we're here"
  // mapping from landing unnoticed.
  it('ignores triggers wmux has no faithful mapping for', () => {
    expect(buildKiroEnvelope(PROMPT_PAYLOAD, { env: baseEnv, now: 1 })).toBeNull();
    for (const trigger of ['preToolUse', 'postToolUse', 'somethingNew']) {
      expect(buildKiroEnvelope({ hook_event_name: trigger, cwd: '/p' }, { env: baseEnv, now: 1 })).toBeNull();
    }
  });

  it('survives payloads that are not the shape kiro documents', () => {
    for (const bad of [null, undefined, 'a string', 42, [], {}, { hook_event_name: 5 }]) {
      expect(buildKiroEnvelope(bad, { env: baseEnv, now: 1 })).toBeNull();
    }
  });

  it('falls back to the process cwd when the payload omits one', () => {
    const envelope = buildKiroEnvelope({ hook_event_name: 'stop' }, { env: baseEnv, now: 1 });
    expect(envelope?.cwd).toBe(process.cwd());
  });

  it('omits workspace and surface ids rather than emitting empty ones', () => {
    const envelope = buildKiroEnvelope(STOP_PAYLOAD, { env: { WMUX_PTY_ID: 'p1' }, now: 1 });
    expect(envelope).not.toHaveProperty('workspaceId');
    expect(envelope).not.toHaveProperty('surfaceId');
  });
});

describe('shouldTryNextTarget', () => {
  // The walk stops at an answered call, and at an ambiguous write — unless
  // re-delivering that kind is harmless. `agent.stop` and
  // `agent.session_start` assert a state rather than append a record, and the
  // server dedups a repeat inside its window, so for those the cost of
  // stopping (a pane that reads as still-working until hook authority ages
  // out) is worse than the cost of a duplicate (nothing).
  it('stops on an answered call', () => {
    expect(shouldTryNextTarget({ ok: true }, 'agent.stop')).toBe(false);
  });

  it('stops on an ambiguous write for a kind that is not idempotent', () => {
    expect(shouldTryNextTarget({ ok: false, error: 'timeout', retryable: false })).toBe(false);
    expect(
      shouldTryNextTarget({ ok: false, error: 'timeout', retryable: false }, 'agent.activity'),
    ).toBe(false);
  });

  it('keeps walking on an ambiguous write for an idempotent kind', () => {
    for (const kind of ['agent.stop', 'agent.session_start']) {
      expect(
        shouldTryNextTarget({ ok: false, error: 'timeout', retryable: false }, kind),
        kind,
      ).toBe(true);
      expect(
        shouldTryNextTarget({ ok: false, error: 'closed-without-response', retryable: false }, kind),
        kind,
      ).toBe(true);
    }
  });

  it('advances on a connect failure that never wrote', () => {
    expect(shouldTryNextTarget({ ok: false, error: 'connect-error', retryable: true })).toBe(true);
  });

  it('advances on an explicit refusal from an older endpoint', () => {
    expect(shouldTryNextTarget({ ok: false, error: 'Unknown method' })).toBe(true);
  });

  // A trigger name that resolves through Object.prototype used to sail past
  // the `!kind` guard and produce an envelope whose kind was a function or
  // `{}`, which then went to the daemon instead of being dropped.
  it('drops trigger names that only exist on the prototype chain', () => {
    for (const trigger of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
      expect(
        buildKiroEnvelope({ hook_event_name: trigger, cwd: 'C:/x' }, { env: { WMUX_PTY_ID: 'p1' }, now: 1 }),
        trigger,
      ).toBeNull();
    }
  });
});
