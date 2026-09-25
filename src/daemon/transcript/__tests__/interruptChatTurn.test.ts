import { describe, expect, it, vi } from 'vitest';
import { interruptChatTurn, type ChatInterruptDeps } from '../interruptChatTurn';
import type { AgentStatus } from '../../../shared/types';

function fixture() {
  const state = { slug: 'claude', status: 'running' as AgentStatus, approval: false, transcript: 'conversation-1' };
  let screen: string[] | null = ['● Writing…', '', '✻ Thinking… (esc to interrupt)', '❯ '];
  const write = vi.fn(() => true);
  const deps: ChatInterruptDeps = {
    getTranscriptSessionId: () => state.transcript, hasOpenApproval: () => state.approval,
    readScreen: async () => screen, getAgentState: () => ({ slug: state.slug, status: state.status }), write,
  };
  return { deps, state, write, show: (rows: string[] | null) => { screen = rows; } };
}

describe('chat Stop interrupts only a running turn', () => {
  it('sends one ESC to a running Claude turn', async () => {
    const f = fixture();
    expect(await interruptChatTurn('conversation-1', f.deps)).toBe('sent');
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.write).toHaveBeenCalledWith('\x1b');
  });
  it('never presses ESC at rest, where it would clear the input line', async () => {
    for (const status of ['idle', 'complete', 'waiting'] as AgentStatus[]) {
      const f = fixture(); f.state.status = status;
      expect(await interruptChatTurn('conversation-1', f.deps)).toBe('not_running');
      expect(f.write).not.toHaveBeenCalled();
    }
  });
  it('refuses approvals, dialogs, unreadable screens, other agents and other conversations', async () => {
    const approval = fixture(); approval.state.approval = true;
    expect(await interruptChatTurn('conversation-1', approval.deps)).toBe('blocked');
    const dialog = fixture(); dialog.show(['Select model', '❯ 1. Opus', '  2. Haiku', 'Enter to confirm · Esc to cancel']);
    expect(await interruptChatTurn('conversation-1', dialog.deps)).toBe('blocked');
    const blind = fixture(); blind.show(null);
    expect(await interruptChatTurn('conversation-1', blind.deps)).toBe('blocked');
    const other = fixture(); other.state.slug = 'opencode';
    expect(await interruptChatTurn('conversation-1', other.deps)).toBe('unavailable');
    const stale = fixture(); stale.state.transcript = 'conversation-2';
    expect(await interruptChatTurn('conversation-1', stale.deps)).toBe('session_changed');
    for (const x of [approval, dialog, blind, other, stale]) expect(x.write).not.toHaveBeenCalled();
  });
  it('re-checks after the screen read', async () => {
    const f = fixture();
    f.deps.readScreen = async () => { f.state.status = 'complete'; return ['❯ ']; };
    expect(await interruptChatTurn('conversation-1', f.deps)).toBe('not_running');
    expect(f.write).not.toHaveBeenCalled();
  });
});
