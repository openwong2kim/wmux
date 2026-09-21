import { describe, expect, it, vi } from 'vitest';
import { deliverChatPrompt, type ChatDeliveryDeps } from '../deliverChatPrompt';
import type { ScheduledPromptAgentState } from '../../sessionPromptDelivery';

function fixture() {
  let approval = false;
  let transcript = 'conversation-1';
  const state: ScheduledPromptAgentState = { slug: 'claude', incarnationId: 'process-1', status: 'complete', inputQuiet: true, inputRevision: 0 };
  const write = vi.fn(() => { state.inputRevision++; return true; });
  const deps: ChatDeliveryDeps = { getAgentState: () => ({ ...state }), getTranscriptSessionId: () => transcript,
    hasOpenApproval: () => approval, isAgentProcessAlive: async () => true, write, delay: async () => undefined };
  return { deps, state, write, gate: () => { approval = true; }, replace: () => { transcript = 'conversation-2'; } };
}
describe('identity-bound chat delivery', () => {
  it('never appends a new task to a potentially restored interrupted draft', async () => {
    const f = fixture(); f.state.status = 'idle';
    expect(await deliverChatPrompt('conversation-1', 'next task', f.deps)).toBe('unconfirmed');
    expect(f.write).not.toHaveBeenCalled();
  });
  it('sends a multiline prompt to the same Claude process using bracketed paste', async () => {
    const f = fixture();
    expect(await deliverChatPrompt('conversation-1', 'first\nsecond', f.deps)).toBe('sent');
    expect(f.write.mock.calls).toHaveLength(2);
    expect(f.write).toHaveBeenNthCalledWith(1, '\x1b[200~first\nsecond\x1b[201~');
    expect(f.write).toHaveBeenNthCalledWith(2, '\r\r');
  });
  it('refuses permission prompts, other agents, old conversations, busy input and oversized drafts', async () => {
    const f = fixture(); f.gate();
    expect(await deliverChatPrompt('conversation-1', 'yes', f.deps)).toBe('blocked');
    const other = fixture(); other.state.slug = 'codex';
    expect(await deliverChatPrompt('conversation-1', 'hello', other.deps)).toBe('unavailable');
    const stale = fixture(); stale.replace();
    expect(await deliverChatPrompt('conversation-1', 'hello', stale.deps)).toBe('session_changed');
    const busy = fixture(); busy.state.status = 'running';
    expect(await deliverChatPrompt('conversation-1', 'hello', busy.deps)).toBe('busy');
    const huge = fixture();
    expect(await deliverChatPrompt('conversation-1', 'x'.repeat(16001), huge.deps)).toBe('error');
    for (const x of [f, other, stale, busy, huge]) expect(x.write).not.toHaveBeenCalled();
  });
  it('cannot escape bracketed paste through message text', async () => {
    const f = fixture();
    expect(await deliverChatPrompt('conversation-1', 'text\x1b[201~command', f.deps)).toBe('sent');
    expect(f.write).toHaveBeenNthCalledWith(1, '\x1b[200~text␛[201~command\x1b[201~');
  });
  it.each(['gate', 'conversation', 'process', 'typing'] as const)('never submits if %s changes after paste', async (change) => {
    const f = fixture();
    f.deps.delay = async () => {
      if (change === 'gate') f.gate();
      if (change === 'conversation') f.replace();
      if (change === 'process') f.state.incarnationId = 'process-2';
      if (change === 'typing') f.state.inputRevision++;
    };
    expect(await deliverChatPrompt('conversation-1', 'hello', f.deps)).toBe('error');
    expect(f.write).toHaveBeenCalledTimes(1);
  });
});
