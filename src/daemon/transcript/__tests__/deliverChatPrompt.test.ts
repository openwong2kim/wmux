import { describe, expect, it, vi } from 'vitest';
import { deliverChatPrompt, type ChatDeliveryDeps } from '../deliverChatPrompt';
import type { ScheduledPromptAgentState } from '../../sessionPromptDelivery';

function fixture() {
  let approval = false;
  let transcript = 'conversation-1';
  let screen: string[] | null = ['● done', '', '❯ ', '  ? for shortcuts'];
  const state: ScheduledPromptAgentState = { slug: 'claude', incarnationId: 'process-1', status: 'complete', inputQuiet: true, inputRevision: 0 };
  const write = vi.fn(() => { state.inputRevision++; return true; });
  const deps: ChatDeliveryDeps = { getAgentState: () => ({ ...state }), getTranscriptSessionId: () => transcript,
    hasOpenApproval: () => approval, readScreen: async () => screen, isAgentProcessAlive: async () => true, write, delay: async () => undefined };
  return { deps, state, write, show: (rows: string[] | null) => { screen = rows; }, gate: () => { approval = true; }, replace: () => { transcript = 'conversation-2'; } };
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
    const other = fixture(); other.state.slug = 'grok';
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
  // Screens captured live (dogfood 2026-09-22): Claude opened these on its own
  // while the pane read `complete`, and Enter confirmed the highlighted row.
  it.each([
    ['post-turn wizard', ['Teach auto mode about your environment?', '', '❯ 1. Yes', '  2. Not now', "  3. Don't show again", '', 'Enter to confirm · Esc to cancel', '❯ ']],
    ['wizard step without numbered rows', ['❯ Also scan shell history    [✓]', '  Also scan your other repos [ ]', '  Continue', '←/→ to change usage · Enter to continue · Esc to cancel']],
    ['/model select', ['Select model', '  1. Default (recommended)', '❯ 2. Opus (1M context) ✓', 'Enter to set as default · s to use this session only · Esc to cancel']],
    ['unreadable screen', null],
    ['blank screen', ['', '   ']],
  ] as const)('refuses while the composer does not own the keyboard: %s', async (_name, rows) => {
    const f = fixture(); f.show(rows ? [...rows] : null);
    expect(await deliverChatPrompt('conversation-1', 'hello', f.deps)).toBe('blocked');
    expect(f.write).not.toHaveBeenCalled();
  });
  it('treats a screen read failure as no evidence of a free composer', async () => {
    const f = fixture(); f.deps.readScreen = async () => { throw new Error('parse budget'); };
    expect(await deliverChatPrompt('conversation-1', 'hello', f.deps)).toBe('blocked');
    expect(f.write).not.toHaveBeenCalled();
  });
});

// Claude Code 2.1.282 screens captured with a PTY probe (2026-09-25).
const RULE = '─'.repeat(40);
const emptyComposer = (above: string[]) => [...above, RULE, '❯ ', RULE, '  ⏸ manual mode on'];
describe('chat delivery into Claude mid-turn and after Stop', () => {
  it('queues a prompt mid-turn only while the composer is visibly empty', async () => {
    const f = fixture(); f.state.status = 'running';
    f.show(emptyComposer(['✢ Effecting… (9s · thinking)']));
    expect(await deliverChatPrompt('conversation-1', 'then say BANANA', f.deps)).toBe('sent');
    expect(f.write.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['\x1b[200~then say BANANA\x1b[201~', '\r']);
    const draft = fixture(); draft.state.status = 'running';
    draft.show([RULE, '❯ half-typed in Terminal', RULE]);
    expect(await deliverChatPrompt('conversation-1', 'then say BANANA', draft.deps)).toBe('busy');
    expect(draft.write).not.toHaveBeenCalled();
  });
  it('sends after a late ESC left the composer empty, but not over a restored draft', async () => {
    const f = fixture(); f.state.status = 'idle';
    f.show(emptyComposer(['  ⎿  Interrupted · What should Claude do instead?']));
    expect(await deliverChatPrompt('conversation-1', 'next', f.deps)).toBe('sent');
    const fresh = fixture(); fresh.state.status = 'idle';
    fresh.show([RULE, '❯ Try "refactor constants.ts"', RULE]);
    expect(await deliverChatPrompt('conversation-1', 'next', fresh.deps)).toBe('sent');
    const restored = fixture(); restored.state.status = 'idle';
    restored.show([RULE, '❯ Write a 900-word essay about the history of tunnels.', RULE]);
    expect(await deliverChatPrompt('conversation-1', 'next', restored.deps)).toBe('unconfirmed');
    expect(restored.write).not.toHaveBeenCalled();
  });
  it('pastes each image path on its own before the prompt, then submits once', async () => {
    const leftover = fixture();
    leftover.show([RULE, '❯ [Image #1] What is this?', RULE]);
    expect(await deliverChatPrompt('conversation-1', 'What is this?', leftover.deps, ['/tmp/a.png'])).toBe('unconfirmed');
    expect(leftover.write).not.toHaveBeenCalled();
    const f = fixture();
    f.show(emptyComposer(['● done']));
    expect(await deliverChatPrompt('conversation-1', 'What is this?', f.deps, ['/tmp/a.png', '/tmp/my shot.png'])).toBe('sent');
    expect(f.write.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      '\x1b[200~/tmp/a.png\x1b[201~', "\x1b[200~'/tmp/my shot.png'\x1b[201~", '\x1b[200~ What is this?\x1b[201~', '\r']);
  });
  it('refuses image paths for Codex and never submits if typing lands between pastes', async () => {
    const codex = fixture(); codex.state.slug = 'codex';
    codex.show(['› Ask Codex to do anything', '  gpt-5 · ~/project']);
    expect(await deliverChatPrompt('conversation-1', 'look', codex.deps, ['/tmp/a.png'])).toBe('unavailable');
    expect(codex.write).not.toHaveBeenCalled();
    const f = fixture();
    f.show(emptyComposer(['● done']));
    let delays = 0;
    f.deps.delay = async () => { if (delays++ === 0) f.state.inputRevision++; };
    expect(await deliverChatPrompt('conversation-1', 'look', f.deps, ['/tmp/a.png', '/tmp/b.png'])).toBe('error');
    // Typing after the first path stops the second paste, not only Enter.
    expect(f.write).toHaveBeenCalledTimes(1);
  });
});
