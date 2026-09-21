import { describe, expect, it } from 'vitest';
import { chatRunState } from '../chatRunState';
import type { TurnEvent } from '../../../../shared/transcript/turnEvents';
const events: TurnEvent[] = [{ id: 'u', kind: 'user_text', text: 'hello' }, { id: 'a', kind: 'assistant_text', text: 'reply' }];
const base = { loading: false, error: false, available: true, sending: false, sent: false, blocked: false, turnOpen: false, events };
describe('truthful chat progress', () => {
  it('recognizes recorded end_turn but never overrides a newer running turn', () => {
    const finished: TurnEvent[] = [...events, { id: 'final', kind: 'assistant_text', text: 'done', turnComplete: true }];
    expect(chatRunState({ ...base, events: finished, status: 'idle' })).toBe('complete');
    // Byte-only activity after end_turn (Claude repainting a /model dialog) is not a turn.
    expect(chatRunState({ ...base, events: finished, status: 'running' })).toBe('complete');
    expect(chatRunState({ ...base, events: finished, status: 'running', turnOpen: true })).toBe('working');
    expect(chatRunState({ ...base, events: finished, status: 'running', sent: true })).toBe('waiting');
    expect(chatRunState({ ...base, events: [...finished, { id: 'next', kind: 'user_text', text: 'next' }], status: 'running' })).toBe('working');
    expect(chatRunState({ ...base, events: finished, turnOpen: true })).toBe('working');
    expect(chatRunState({ ...base, events: [...finished, { id: 'next', kind: 'user_text', text: 'next' }], status: 'idle' })).toBe('unconfirmed');
  });
  it('keeps a silent open turn running even without an attention status', () => {
    expect(chatRunState({ ...base, turnOpen: true })).toBe('working');
  });
  it('never treats silence, idle, partial text or a tool call as completion', () => {
    expect(chatRunState({ ...base, status: 'idle' })).toBe('unconfirmed');
    expect(chatRunState({ ...base, status: 'complete', events: [events[0]] })).toBe('unconfirmed');
    expect(chatRunState({ ...base, status: 'complete' })).toBe('complete');
  });
  it('shows disconnection and approval waits ahead of stale running status', () => {
    expect(chatRunState({ ...base, error: true, status: 'running' })).toBe('disconnected');
    expect(chatRunState({ ...base, blocked: true, turnOpen: true })).toBe('blocked');
  });
  it('distinguishes pending delivery, response wait and an exited agent', () => {
    expect(chatRunState({ ...base, sending: true })).toBe('sending');
    expect(chatRunState({ ...base, sent: true, status: 'complete' })).toBe('waiting');
    expect(chatRunState({ ...base, agentAlive: false })).toBe('ended');
  });
});
