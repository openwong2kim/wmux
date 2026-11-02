import { describe, expect, it } from 'vitest';
import {
  ANNOUNCE_INTERVAL_MS,
  diffAgentStates,
  EMPTY_RATE_STATE,
  rateLimitAnnouncements,
  type AgentPaneState,
} from '../agentAnnouncements';
import type { AgentStatus } from '../../../shared/types';

function pane(ptyId: string, agentStatus: AgentStatus, agent = 'Claude Code', tag = `#w1-${ptyId}`): AgentPaneState {
  return { ptyId, tag, agent, agentStatus };
}

describe('diffAgentStates', () => {
  it('announces nothing for the first snapshot', () => {
    expect(diffAgentStates(null, [pane('1', 'awaiting_input'), pane('2', 'error')])).toEqual([]);
  });

  it('says a pane needs you when it changes into awaiting_input', () => {
    expect(diffAgentStates([pane('1', 'running')], [pane('1', 'awaiting_input')])).toEqual([
      { kind: 'needsYou', tag: '#w1-1', agent: 'Claude Code' },
    ]);
    expect(diffAgentStates([pane('1', 'idle')], [pane('1', 'awaiting_input')])).toEqual([
      { kind: 'needsYou', tag: '#w1-1', agent: 'Claude Code' },
    ]);
  });

  it('says a pane finished only on running into waiting or complete', () => {
    expect(diffAgentStates([pane('1', 'running')], [pane('1', 'waiting')])).toEqual([
      { kind: 'finished', tag: '#w1-1', agent: 'Claude Code' },
    ]);
    expect(diffAgentStates([pane('1', 'running')], [pane('1', 'complete')])).toEqual([
      { kind: 'finished', tag: '#w1-1', agent: 'Claude Code' },
    ]);
    expect(diffAgentStates([pane('1', 'idle')], [pane('1', 'complete')])).toEqual([]);
    expect(diffAgentStates([pane('1', 'awaiting_input')], [pane('1', 'waiting')])).toEqual([]);
  });

  it('says a pane stopped with an error when it changes into error', () => {
    expect(diffAgentStates([pane('1', 'running')], [pane('1', 'error')])).toEqual([
      { kind: 'error', tag: '#w1-1', agent: 'Claude Code' },
    ]);
  });

  it('announces nothing when the status did not change', () => {
    const same = [pane('1', 'awaiting_input'), pane('2', 'error'), pane('3', 'complete')];
    expect(diffAgentStates(same, same)).toEqual([]);
  });

  it('announces nothing for a pane without an agent, now or before', () => {
    expect(diffAgentStates([pane('1', 'running', '')], [pane('1', 'error', '')])).toEqual([]);
    // The agent appeared with this snapshot: no earlier state to change from.
    expect(diffAgentStates([pane('1', 'running', '')], [pane('1', 'awaiting_input')])).toEqual([]);
    expect(diffAgentStates([], [pane('1', 'awaiting_input')])).toEqual([]);
  });

  it('keeps the order of the new snapshot', () => {
    const prev = [pane('1', 'running'), pane('2', 'running')];
    const next = [pane('2', 'error'), pane('1', 'waiting')];
    expect(diffAgentStates(prev, next).map((a) => a.kind)).toEqual(['error', 'finished']);
  });
});

describe('rateLimitAnnouncements', () => {
  it('announces at once when nothing was announced in the last 2 s', () => {
    const step = rateLimitAnnouncements(EMPTY_RATE_STATE, ['a'], 1000);
    expect(step.announce).toBe('a');
    expect(step.retryInMs).toBeNull();
    const later = rateLimitAnnouncements(step.state, ['b'], 1000 + ANNOUNCE_INTERVAL_MS);
    expect(later.announce).toBe('b');
  });

  it('holds lines that arrive within 2 s and joins them into the next one', () => {
    const first = rateLimitAnnouncements(EMPTY_RATE_STATE, ['a'], 0);
    const held = rateLimitAnnouncements(first.state, ['b'], 500);
    expect(held.announce).toBeNull();
    expect(held.retryInMs).toBe(1500);
    const held2 = rateLimitAnnouncements(held.state, ['c'], 1000);
    expect(held2.announce).toBeNull();
    expect(held2.retryInMs).toBe(1000);
    const due = rateLimitAnnouncements(held2.state, [], 2000);
    expect(due.announce).toBe('b. c');
    expect(due.state.pending).toEqual([]);
    expect(due.retryInMs).toBeNull();
  });

  it('keeps at most 3 lines, dropping the oldest first', () => {
    const first = rateLimitAnnouncements(EMPTY_RATE_STATE, ['a'], 0);
    const held = rateLimitAnnouncements(first.state, ['b', 'c', 'd'], 100);
    const held2 = rateLimitAnnouncements(held.state, ['e'], 200);
    expect(held2.state.pending).toEqual(['c', 'd', 'e']);
    expect(rateLimitAnnouncements(held2.state, [], 2000).announce).toBe('c. d. e');
  });

  it('caps a burst that arrives when free, too', () => {
    expect(rateLimitAnnouncements(EMPTY_RATE_STATE, ['a', 'b', 'c', 'd'], 0).announce).toBe('b. c. d');
  });

  it('does nothing with no lines', () => {
    const step = rateLimitAnnouncements(EMPTY_RATE_STATE, [], 0);
    expect(step.announce).toBeNull();
    expect(step.retryInMs).toBeNull();
    expect(step.state).toBe(EMPTY_RATE_STATE);
  });
});
