import { describe, expect, it, vi } from 'vitest';
import { interruptChatTurn, type ChatInterruptDeps } from '../interruptChatTurn';
import { screenShowsRunningTurn } from '../chatScreenGate';
import type { AgentStatus } from '../../../shared/types';
import screens from './fixtures/running-turn-screens.json';

type Frames = Record<string, string[]>;
const frames = screens as unknown as Frames & { _about: { evidence: string[]; noEvidence: Record<string, string> } };
const slugOf = (name: string) => name.split('-')[0];

function fixture() {
  const state = {
    slug: 'claude', status: 'running' as AgentStatus, approval: false, transcript: 'conversation-1',
    turn: { id: 't1:n.1', state: 'running' as 'running' | 'idle', startedAt: 1_000 } as { id: string; state: 'running' | 'idle'; startedAt?: number } | undefined,
    escAt: 0, now: 10_000,
  };
  let screen: string[] | null = frames['claude-tool'];
  const write = vi.fn((data: string) => { if (data === '\x1b') state.escAt = state.now; return true; });
  const deps: ChatInterruptDeps = {
    getTranscriptSessionId: () => state.transcript, hasOpenApproval: () => state.approval,
    readScreen: async () => screen,
    getAgentState: () => ({ slug: state.slug, status: state.status, ...(state.turn ? { turn: state.turn } : {}) }),
    write, lastEscAt: () => state.escAt, now: () => state.now,
  };
  return { deps, state, write, show: (rows: string[] | null) => { screen = rows; } };
}

describe('running-turn evidence against real captures', () => {
  it('finds the running row in every mid-turn frame that draws one', () => {
    for (const name of frames._about.evidence) expect(screenShowsRunningTurn(frames[name], slugOf(name)), name).toBe(true);
  });
  it('finds none while starting, streaming or after the interrupt', () => {
    for (const name of Object.keys(frames._about.noEvidence)) expect(screenShowsRunningTurn(frames[name], slugOf(name)), name).toBe(false);
  });
  it('never reads one agent\'s row as the other\'s, and ignores finished-turn and idle rows', () => {
    expect(screenShowsRunningTurn(frames['codex-working'], 'claude')).toBe(false);
    expect(screenShowsRunningTurn(frames['claude-tool'], 'codex')).toBe(false);
    expect(screenShowsRunningTurn(frames['claude-tool'], 'opencode')).toBe(false);
    for (const row of ['✻ Worked for 12s', '✻ Cooked for 1m 3s', '✳ Claude Code', '❯ Try "edit <filepath> to..."',
      '◐ medium · /effort', '⎿  Interrupted · What should Claude do instead?', '> ✻ Thinking… (5s · ↓ 1k tokens) typed by a user']) {
      expect(screenShowsRunningTurn([row], 'claude'), row).toBe(false);
    }
    expect(screenShowsRunningTurn(['  a user wrote: esc to interrupt)'], 'codex')).toBe(false);
    expect(screenShowsRunningTurn(null, 'claude')).toBe(false);
  });
  it('accepts the hook-phase and long-running counters', () => {
    for (const row of ['✢ Onioning… (running UserPromptSubmit hook · 0s)', '✶ Befuddling… (1m 12s · ↑ 3.4k tokens)', '✽ Forging… (↓ 1.2k tokens)']) {
      expect(screenShowsRunningTurn([row], 'claude'), row).toBe(true);
    }
  });
});

describe('chat Stop interrupts only a running turn', () => {
  it('sends one ESC to a running Claude turn', async () => {
    const f = fixture();
    expect(await interruptChatTurn('conversation-1', f.deps)).toBe('sent');
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.write).toHaveBeenCalledWith('\x1b');
  });
  it('sends one ESC to a running Codex turn', async () => {
    const f = fixture(); f.state.slug = 'codex'; f.show(frames['codex-working']);
    expect(await interruptChatTurn('conversation-1', f.deps)).toBe('sent');
  });
  it('never presses ESC at rest, where it would clear the input line', async () => {
    for (const status of ['idle', 'complete', 'waiting'] as AgentStatus[]) {
      const f = fixture(); f.state.status = status;
      expect(await interruptChatTurn('conversation-1', f.deps)).toBe('not_running');
      expect(f.write).not.toHaveBeenCalled();
    }
  });
  it('refuses a running status without the agent\'s own running row on screen', async () => {
    for (const name of ['claude-streaming', 'claude-interrupted', 'claude-starting']) {
      const f = fixture(); f.show(frames[name]);
      expect(await interruptChatTurn('conversation-1', f.deps), name).toBe('not_running');
      expect(f.write).not.toHaveBeenCalled();
    }
  });
  it('refuses approvals, dialogs, unreadable screens, other agents and other conversations', async () => {
    const approval = fixture(); approval.state.approval = true;
    expect(await interruptChatTurn('conversation-1', approval.deps)).toBe('blocked');
    const awaiting = fixture(); awaiting.state.status = 'awaiting_input';
    expect(await interruptChatTurn('conversation-1', awaiting.deps)).toBe('blocked');
    const dialog = fixture(); dialog.show(['Select model', '❯ 1. Opus', '  2. Haiku', 'Enter to confirm · Esc to cancel']);
    expect(await interruptChatTurn('conversation-1', dialog.deps)).toBe('blocked');
    const blind = fixture(); blind.show(null);
    expect(await interruptChatTurn('conversation-1', blind.deps)).toBe('blocked');
    const other = fixture(); other.state.slug = 'opencode';
    expect(await interruptChatTurn('conversation-1', other.deps)).toBe('unavailable');
    const stale = fixture(); stale.state.transcript = 'conversation-2';
    expect(await interruptChatTurn('conversation-1', stale.deps)).toBe('session_changed');
    for (const x of [approval, awaiting, dialog, blind, other, stale]) expect(x.write).not.toHaveBeenCalled();
  });
  it('a turnId that is not the running turn writes nothing', async () => {
    const f = fixture();
    expect(await interruptChatTurn('conversation-1', { ...f.deps, expectedTurnId: 't1:n.0' })).toBe('turn_mismatch');
    f.state.turn = undefined;
    expect(await interruptChatTurn('conversation-1', { ...f.deps, expectedTurnId: 't1:n.1' })).toBe('turn_mismatch');
    const idle = fixture(); idle.state.turn = { id: 't1:n.1', state: 'idle', startedAt: 1_000 };
    expect(await interruptChatTurn('conversation-1', { ...idle.deps, expectedTurnId: 't1:n.1' })).toBe('not_running');
    expect(f.write).not.toHaveBeenCalled();
    expect(idle.write).not.toHaveBeenCalled();
    const match = fixture();
    expect(await interruptChatTurn('conversation-1', { ...match.deps, expectedTurnId: 't1:n.1' })).toBe('sent');
  });
  it('one ESC per turn and a 2 s cooldown per pane, whatever wrote the last ESC', async () => {
    const f = fixture();
    expect(await interruptChatTurn('conversation-1', f.deps)).toBe('sent');
    f.state.now += 5_000;
    expect(await interruptChatTurn('conversation-1', f.deps)).toBe('already_interrupted');
    // A new turn opened 500 ms after the last ESC: the cooldown still holds.
    f.state.turn = { id: 't1:n.2', state: 'running', startedAt: f.state.escAt + 100 };
    f.state.now = f.state.escAt + 500;
    expect(await interruptChatTurn('conversation-1', f.deps)).toBe('cooldown');
    f.state.now = f.state.escAt + 2_000;
    expect(await interruptChatTurn('conversation-1', f.deps)).toBe('sent');
    expect(f.write).toHaveBeenCalledTimes(2);
  });
  it('re-checks after the screen read and the authorization', async () => {
    const f = fixture();
    f.deps.readScreen = async () => { f.state.status = 'complete'; return frames['claude-tool']; };
    expect(await interruptChatTurn('conversation-1', f.deps)).toBe('not_running');
    const raced = fixture();
    raced.deps.readScreen = async () => { raced.state.escAt = raced.state.now; return frames['claude-tool']; };
    expect(await interruptChatTurn('conversation-1', raced.deps)).toBe('already_interrupted');
    const denied = fixture();
    expect(await interruptChatTurn('conversation-1', { ...denied.deps, authorized: async () => false })).toBe('unauthorized');
    for (const x of [f, raced, denied]) expect(x.write).not.toHaveBeenCalled();
  });
});
