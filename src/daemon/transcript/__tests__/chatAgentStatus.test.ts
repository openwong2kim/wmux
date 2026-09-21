import { expect, it } from 'vitest';
import { chatAgentStatus } from '../chatAgentStatus';
const final = { id: 'a', kind: 'assistant_text' as const, text: 'done', ts: 200, turnComplete: true };
it('reconciles repaint activity only with a current recorded completion', () => {
  expect(chatAgentStatus('running', final, 100)).toBe('complete');
  expect(chatAgentStatus('running', final, 300)).toBe('running');
  expect(chatAgentStatus('awaiting_input', final, 100)).toBe('awaiting_input');
  expect(chatAgentStatus('error', final, 100)).toBe('error');
  expect(chatAgentStatus('idle', { ...final, turnComplete: undefined }, 100)).toBe('idle');
  expect(chatAgentStatus('running', { id: 'u', kind: 'user_text', text: 'next', ts: 300 }, 100)).toBe('running');
});
