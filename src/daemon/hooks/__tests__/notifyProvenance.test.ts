import { describe, it, expect } from 'vitest';
import { applyNotifyProvenance, notifyProvenance } from '../notifyProvenance';
import { isSessionRoutedNotify, type AgentSignal } from '../../../shared/hooks/signal-types';
const signal = (format = 'official'): AgentSignal => ({ agent: 'codex', kind: 'agent.stop',
  agentSessionId: 'session', cwd: '/repo', ts: 1, ptyId: 'pane', payload: { source: 'codex.notify', notifyFormat: format } });
describe('notification parent provenance', () => {
  it('accepts a descendant of the claimed pane shell and detects a detached host', () => {
    const tree = new Map([[40, 30], [30, 20], [20, 1], [90, 1]]);
    expect(notifyProvenance(40, 20, tree)).toBe('owned');
    expect(isSessionRoutedNotify(applyNotifyProvenance(signal(), 'owned'))).toBe(false);
    expect(notifyProvenance(90, 20, tree)).toBe('foreign');
    expect(isSessionRoutedNotify(applyNotifyProvenance(signal(), 'foreign'))).toBe(true);
    expect(notifyProvenance(1, 20, tree)).toBe('foreign');
  });
  it.each([undefined, 0, -1, '40', NaN])('does not infer ownership from invalid parent %s', parent => {
    expect(notifyProvenance(parent, 20, new Map())).toBe('unknown');
  });
  it('preserves session_id-only compatibility unless ancestry proves it foreign', () => {
    const legacy = signal('legacy');
    expect(applyNotifyProvenance(legacy, 'unknown')).toMatchObject({ ptyId: 'pane', agentSessionId: 'session' });
    expect(isSessionRoutedNotify(applyNotifyProvenance(legacy, 'unknown'))).toBe(false);
    expect(isSessionRoutedNotify(applyNotifyProvenance(legacy, 'foreign'))).toBe(true);
    expect(notifyProvenance(40, 20, undefined)).toBe('unknown');
    expect(notifyProvenance(40, 20, new Map([[40, 30], [30, 40]]))).toBe('unknown');
  });
  it('uses only the explicit marker and tolerates absent payload', () => {
    expect(isSessionRoutedNotify({ ...signal(), payload: undefined as never })).toBe(false);
    expect(isSessionRoutedNotify({ ...signal(), payload: { 'turn-id': 'turn' } })).toBe(false);
  });
});
