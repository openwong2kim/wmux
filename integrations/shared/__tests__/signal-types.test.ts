import { describe, it, expect } from 'vitest';
import { isAgentSignal } from '../signal-types';

describe('isAgentSignal', () => {
  const valid = {
    kind: 'agent.stop',
    agent: 'claude',
    cwd: '/foo',
    payload: {},
    ts: 12345,
  };

  it('accepts a minimal valid envelope', () => {
    expect(isAgentSignal(valid)).toBe(true);
  });

  it('accepts an envelope with optional agentSessionId', () => {
    expect(isAgentSignal({ ...valid, agentSessionId: 'sess-1' })).toBe(true);
  });

  it.each([
    'agent.stop',
    'agent.activity',
    'agent.subagent_stop',
    'agent.session_start',
  ])('accepts kind = %s', (kind) => {
    expect(isAgentSignal({ ...valid, kind })).toBe(true);
  });

  it('rejects unknown kind', () => {
    expect(isAgentSignal({ ...valid, kind: 'agent.something_else' })).toBe(false);
  });

  it('rejects null / undefined / primitive inputs', () => {
    expect(isAgentSignal(null)).toBe(false);
    expect(isAgentSignal(undefined)).toBe(false);
    expect(isAgentSignal('string')).toBe(false);
    expect(isAgentSignal(42)).toBe(false);
    expect(isAgentSignal(true)).toBe(false);
  });

  it('rejects missing required fields', () => {
    const { kind: _kind, ...noKind } = valid;
    expect(isAgentSignal(noKind)).toBe(false);
    const { agent: _agent, ...noAgent } = valid;
    expect(isAgentSignal(noAgent)).toBe(false);
    const { cwd: _cwd, ...noCwd } = valid;
    expect(isAgentSignal(noCwd)).toBe(false);
    const { ts: _ts, ...noTs } = valid;
    expect(isAgentSignal(noTs)).toBe(false);
    const { payload: _payload, ...noPayload } = valid;
    expect(isAgentSignal(noPayload)).toBe(false);
  });

  it('rejects empty cwd', () => {
    expect(isAgentSignal({ ...valid, cwd: '' })).toBe(false);
  });

  it('rejects non-numeric ts', () => {
    expect(isAgentSignal({ ...valid, ts: '1000' })).toBe(false);
    expect(isAgentSignal({ ...valid, ts: NaN })).toBe(false);
    expect(isAgentSignal({ ...valid, ts: Infinity })).toBe(false);
  });

  it('rejects null payload', () => {
    expect(isAgentSignal({ ...valid, payload: null })).toBe(false);
  });

  it('rejects non-string agentSessionId when present', () => {
    expect(isAgentSignal({ ...valid, agentSessionId: 12345 })).toBe(false);
  });
});
