import { describe, it, expect, vi } from 'vitest';
import { StarPromptSessionCounter, isCountableAgentStart, type StarPromptSessionDeps } from '../starPromptSessions';
import type { AgentSignal } from '../../../shared/hooks/signal-types';

const PTY = 'pty-1';

const NO_SOURCE = Symbol('no source');

function signal(over: Partial<AgentSignal> = {}, source: unknown = 'startup'): AgentSignal {
  return {
    kind: 'agent.session_start',
    agent: 'claude',
    agentSessionId: 'sess-a',
    ptyId: PTY,
    cwd: '/repo',
    ts: 1,
    payload: source === NO_SOURCE ? {} : { source },
    ...over,
  } as AgentSignal;
}

const human: StarPromptSessionDeps = { isBotWorker: () => false, isBrain: () => false };

describe('isCountableAgentStart', () => {
  it('counts a new session a person started on its own pane', () => {
    expect(isCountableAgentStart(PTY, signal(), human)).toBe(true);
  });

  it('skips resume (restored panes after a crash or reboot), /clear and compaction', () => {
    for (const source of ['resume', 'clear', 'compact', NO_SOURCE, null, 7]) {
      expect(isCountableAgentStart(PTY, signal({}, source), human)).toBe(false);
    }
  });

  it('needs the exact pane', () => {
    expect(isCountableAgentStart(PTY, signal({ ptyId: 'other' }), human)).toBe(false);
    expect(isCountableAgentStart(PTY, signal({ ptyId: undefined }), human)).toBe(false);
    expect(isCountableAgentStart('', signal({ ptyId: '' }), human)).toBe(false);
  });

  it('skips other hook kinds and a missing signal', () => {
    expect(isCountableAgentStart(PTY, signal({ kind: 'agent.stop' }), human)).toBe(false);
    expect(isCountableAgentStart(PTY, undefined, human)).toBe(false);
  });

  it('skips bot workers and the orchestrator brain', () => {
    expect(isCountableAgentStart(PTY, signal(), { ...human, isBotWorker: () => true })).toBe(false);
    expect(isCountableAgentStart(PTY, signal(), { ...human, isBrain: () => true })).toBe(false);
  });
});

describe('StarPromptSessionCounter', () => {
  it('tells its sinks once per new session, and dedups a re-delivered hook', () => {
    const counter = new StarPromptSessionCounter(human);
    const sink = vi.fn();
    counter.onSession(sink);
    expect(counter.note(PTY, signal())).toBe(true);
    expect(counter.note(PTY, signal())).toBe(false);
    expect(counter.note(PTY, signal({ agentSessionId: 'sess-b' }))).toBe(true);
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it('dedups on the hook time when the agent gives no session id', () => {
    const counter = new StarPromptSessionCounter(human);
    expect(counter.note(PTY, signal({ agentSessionId: undefined, ts: 5 }))).toBe(true);
    expect(counter.note(PTY, signal({ agentSessionId: undefined, ts: 5 }))).toBe(false);
    expect(counter.note(PTY, signal({ agentSessionId: undefined, ts: 6 }))).toBe(true);
  });

  it('keeps sessions counted before anyone subscribed until they are drained', () => {
    const counter = new StarPromptSessionCounter(human);
    counter.note(PTY, signal());
    counter.note(PTY, signal({ agentSessionId: 'sess-b' }));
    counter.note(PTY, signal({ agentSessionId: 'sess-b' }));
    counter.note(PTY, signal({}, 'resume'));
    expect(counter.drain()).toBe(2);
    expect(counter.drain()).toBe(0);
    counter.note(PTY, signal({ agentSessionId: 'sess-c' }));
    expect(counter.drain()).toBe(1);
  });

  it('still drops a re-delivered session after many other sessions', () => {
    const counter = new StarPromptSessionCounter(human);
    expect(counter.note(PTY, signal({ agentSessionId: 'first' }))).toBe(true);
    for (let i = 0; i < 1000; i++) counter.note(PTY, signal({ agentSessionId: `s${i}` }));
    expect(counter.note(PTY, signal({ agentSessionId: 'first' }))).toBe(false);
    expect(counter.drain()).toBe(1001);
  });

  it('does not tell sinks about a resume', () => {
    const counter = new StarPromptSessionCounter(human);
    const sink = vi.fn();
    counter.onSession(sink);
    expect(counter.note(PTY, signal({}, 'resume'))).toBe(false);
    expect(sink).not.toHaveBeenCalled();
  });

  it('keeps going past a throwing sink or a throwing check, and unsubscribes', () => {
    const counter = new StarPromptSessionCounter(human);
    const good = vi.fn();
    counter.onSession(() => { throw new Error('broken'); });
    const off = counter.onSession(good);
    expect(counter.note(PTY, signal())).toBe(true);
    expect(good).toHaveBeenCalledTimes(1);
    off();
    counter.note(PTY, signal({ agentSessionId: 'sess-c' }));
    expect(good).toHaveBeenCalledTimes(1);

    const throwing = new StarPromptSessionCounter({ isBotWorker: () => { throw new Error('io'); }, isBrain: () => false });
    expect(throwing.note(PTY, signal())).toBe(false);
  });
});
