import { describe, expect, it, vi } from 'vitest';
import { interruptChatTurn, type ChatInterruptDeps } from '../interruptChatTurn';
import { TITLE_FRESH_MS, screenShowsRunningTurn, titleShowsRunningTurn } from '../chatScreenGate';
import type { AgentStatus } from '../../../shared/types';
import fs from 'node:fs';
import path from 'node:path';

// Read, not imported: tsconfig.daemon.json compiles tests without resolveJsonModule.
const screens: unknown = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'running-turn-screens.json'), 'utf8'),
);

type Frame = { rows: string[]; title: { title: string; ageMs: number } };
const captured = screens as unknown as Record<string, Frame> & {
  _about: { screenEvidence: string[]; titleOnlyEvidence: Record<string, string>; noEvidence: Record<string, string> };
};
const NAMES = Object.keys(captured).filter((k) => k !== '_about');
const frames: Record<string, string[]> = Object.fromEntries(NAMES.map((k) => [k, captured[k].rows]));
/** The frame's title as the bridge would report it at `now`. */
const titleOf = (name: string, now: number) => ({ title: captured[name].title.title, at: now - captured[name].title.ageMs });
const slugOf = (name: string) => name.split('-')[0];

function fixture() {
  const state = {
    slug: 'claude', status: 'running' as AgentStatus, approval: false, transcript: 'conversation-1',
    turn: { id: 't1:n.1', state: 'running' as 'running' | 'idle', startedAt: 1_000 } as { id: string; state: 'running' | 'idle'; startedAt?: number } | undefined,
    escAt: 0, now: 10_000,
  };
  let screen: string[] | null = frames['claude-tool'];
  let title: { title: string; at: number } | null = null;
  const write = vi.fn((data: string) => { if (data === '\x1b') state.escAt = state.now; return true; });
  const deps: ChatInterruptDeps = {
    getTranscriptSessionId: () => state.transcript, hasOpenApproval: () => state.approval,
    readScreen: async () => screen,
    getAgentState: () => ({ slug: state.slug, status: state.status, ...(state.turn ? { turn: state.turn } : {}) }),
    write, lastEscAt: () => state.escAt, now: () => state.now, readTitle: () => title,
  };
  return { deps, state, write, show: (rows: string[] | null) => { screen = rows; },
    frame: (name: string) => { screen = frames[name]; title = titleOf(name, state.now); state.slug = slugOf(name); },
    setTitle: (t: { title: string; at: number } | null) => { title = t; } };
}

describe('running-turn evidence against real captures', () => {
  it('finds the running row in every mid-turn frame that draws one', () => {
    for (const name of captured._about.screenEvidence) expect(screenShowsRunningTurn(frames[name], slugOf(name)), name).toBe(true);
  });
  it('finds no row while starting, streaming or after the turn', () => {
    for (const name of [...Object.keys(captured._about.titleOnlyEvidence), ...Object.keys(captured._about.noEvidence)]) {
      expect(screenShowsRunningTurn(frames[name], slugOf(name)), name).toBe(false);
    }
  });
  it('the title spinner is up in every running frame and gone once the turn ends', () => {
    const now = 1_000_000;
    for (const name of [...captured._about.screenEvidence, ...Object.keys(captured._about.titleOnlyEvidence)]) {
      expect(titleShowsRunningTurn(titleOf(name, now), slugOf(name), now), name).toBe(true);
    }
    for (const name of Object.keys(captured._about.noEvidence)) {
      expect(titleShowsRunningTurn({ title: captured[name].title.title, at: now }, slugOf(name), now), name).toBe(false);
    }
  });
  it('a title spinner older than the freshness window, or another agent\'s, proves nothing', () => {
    const now = 1_000_000;
    expect(titleShowsRunningTurn({ title: '◐ Sleep command test', at: now - TITLE_FRESH_MS - 1 }, 'claude', now)).toBe(false);
    expect(titleShowsRunningTurn({ title: '◐ Sleep command test', at: now - TITLE_FRESH_MS }, 'claude', now)).toBe(true);
    expect(titleShowsRunningTurn({ title: '◐ Sleep command test', at: now }, 'codex', now)).toBe(false);
    expect(titleShowsRunningTurn({ title: '⠙ x | cwd', at: now }, 'claude', now)).toBe(false);
    expect(titleShowsRunningTurn({ title: '◐ x', at: 0 }, 'claude', now)).toBe(false);
    expect(titleShowsRunningTurn(null, 'claude', now)).toBe(false);
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
  it('mid-stream: no row on screen, but the running title spinner is evidence', async () => {
    for (const name of Object.keys(captured._about.titleOnlyEvidence)) {
      const f = fixture(); f.frame(name);
      expect(await interruptChatTurn('conversation-1', f.deps), name).toBe('sent');
    }
  });
  it('refuses a running status with neither the row nor a fresh title spinner', async () => {
    for (const name of Object.keys(captured._about.noEvidence)) {
      const f = fixture(); f.frame(name);
      expect(await interruptChatTurn('conversation-1', f.deps), name).toBe('not_running');
      expect(f.write).not.toHaveBeenCalled();
    }
    // A spinner title the agent stopped refreshing (killed mid-turn).
    const stale = fixture(); stale.frame('claude-streaming');
    stale.setTitle({ title: '◑ English number words 1-200', at: stale.state.now - TITLE_FRESH_MS - 1 });
    expect(await interruptChatTurn('conversation-1', stale.deps)).toBe('not_running');
    const none = fixture(); none.show(frames['claude-streaming']);
    expect(await interruptChatTurn('conversation-1', none.deps)).toBe('not_running');
  });
  it('authorizes before the screen read, and reads the title after it, right before the write', async () => {
    const order: string[] = [];
    const f = fixture(); f.frame('claude-streaming');
    f.deps.authorized = async () => { order.push('auth'); return true; };
    const read = f.deps.readScreen;
    f.deps.readScreen = async () => {
      order.push('screen');
      // The turn ends while the screen is read: the title set now wins.
      f.setTitle({ title: '✳ English number words 1-200', at: f.state.now });
      return read();
    };
    expect(await interruptChatTurn('conversation-1', f.deps)).toBe('not_running');
    expect(order).toEqual(['auth', 'screen']);
    expect(f.write).not.toHaveBeenCalled();
    const refused = fixture();
    expect(await interruptChatTurn('conversation-1', { ...refused.deps, beforeWrite: () => false })).toBe('write_refused');
    expect(refused.write).not.toHaveBeenCalled();
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
    // No episode, or one without a start, cannot hold the once-per-turn latch.
    expect(await interruptChatTurn('conversation-1', f.deps)).toBe('not_running');
    f.state.turn = { id: 't1:n.1', state: 'running' };
    expect(await interruptChatTurn('conversation-1', f.deps)).toBe('not_running');
    const idle = fixture(); idle.state.turn = { id: 't1:n.1', state: 'idle', startedAt: 1_000 };
    expect(await interruptChatTurn('conversation-1', { ...idle.deps, expectedTurnId: 't1:n.1' })).toBe('not_running');
    expect(f.write).not.toHaveBeenCalled();
    expect(idle.write).not.toHaveBeenCalled();
    const match = fixture();
    expect(await interruptChatTurn('conversation-1', { ...match.deps, expectedTurnId: 't1:n.1' })).toBe('sent');
  });
  it('a turn that just ended is refused even with its running row still drawn', async () => {
    // Claude's idle title set during this turn outranks the row.
    const claude = fixture(); claude.setTitle({ title: '✳ Sleep command test', at: claude.state.now - 100 });
    expect(await interruptChatTurn('conversation-1', claude.deps)).toBe('not_running');
    // Codex dropped its spinner during this turn.
    const codex = fixture(); codex.frame('codex-working'); codex.setTitle({ title: 'List numbers | cwd-codex', at: codex.state.now - 100 });
    expect(await interruptChatTurn('conversation-1', codex.deps)).toBe('not_running');
    // Claude's Stop hooks run under the spinner after the answer is complete.
    const hooks = fixture(); hooks.show(['⏺ ok', '', '✻ Musing… (running Stop hooks… 0/2 · 2s)', '❯ ']);
    hooks.setTitle({ title: '◐ Single word ok', at: hooks.state.now });
    expect(await interruptChatTurn('conversation-1', hooks.deps)).toBe('not_running');
    for (const x of [claude, codex, hooks]) expect(x.write).not.toHaveBeenCalled();
    // An idle title from before the turn says nothing about it.
    const before = fixture(); before.setTitle({ title: '✳ Claude Code', at: 500 });
    expect(await interruptChatTurn('conversation-1', before.deps)).toBe('sent');
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

describe('native interrupt before the ESC (Codex turn/interrupt)', () => {
  it('writes no ESC when the agent\'s own stream proved the turn interrupted', async () => {
    const f = fixture();
    const native = vi.fn(async () => 'interrupted' as const);
    const beforeWrite = vi.fn(() => true);
    await expect(interruptChatTurn('conversation-1', { ...f.deps, beforeWrite, native })).resolves.toBe('sent');
    expect(beforeWrite).toHaveBeenCalledBefore(native);
    expect(f.write).not.toHaveBeenCalled();
  });
  it('never aims the ESC at a turn that replaced the aimed one during the native wait', async () => {
    const f = fixture();
    const native = vi.fn(async () => { f.state.turn = { id: 't1:n.2', state: 'running', startedAt: 9_000 }; return 'not-written' as const; });
    await expect(interruptChatTurn('conversation-1', { ...f.deps, native })).resolves.toBe('not_running');
    expect(f.write).not.toHaveBeenCalled();
    // The same after a request that may have landed: an interrupt was written.
    const g = fixture();
    const uncertain = vi.fn(async () => { g.state.turn = { id: 't1:n.2', state: 'running', startedAt: 9_000 }; return 'uncertain' as const; });
    await expect(interruptChatTurn('conversation-1', { ...g.deps, native: uncertain })).resolves.toBe('sent');
    expect(g.write).not.toHaveBeenCalled();
  });
  it('latches the pane on a proven native stop, and on a landed request whose ESC is refused, naming the refusal', async () => {
    const f = fixture();
    const noteInterrupt = vi.fn();
    await interruptChatTurn('conversation-1', { ...f.deps, native: async () => 'interrupted' as const, noteInterrupt });
    expect(noteInterrupt).toHaveBeenCalledOnce();
    const g = fixture();
    const refused = vi.fn();
    const gNote = vi.fn();
    // The pinned native target is no longer the running turn: no ESC.
    await expect(interruptChatTurn('conversation-1', { ...g.deps, native: async () => 'uncertain' as const,
      nativeStillAimed: () => false, noteInterrupt: gNote, fallbackRefused: refused })).resolves.toBe('sent');
    expect(g.write).not.toHaveBeenCalled();
    expect(gNote).toHaveBeenCalledOnce();
    expect(refused).toHaveBeenCalledWith('not_running');
    // Nothing written natively and the target is gone: a plain refusal, no latch.
    const h = fixture();
    const hNote = vi.fn();
    await expect(interruptChatTurn('conversation-1', { ...h.deps, native: async () => 'not-written' as const,
      nativeStillAimed: () => false, noteInterrupt: hNote })).resolves.toBe('not_running');
    expect(h.write).not.toHaveBeenCalled();
    expect(hNote).not.toHaveBeenCalled();
  });
  it('a native failure that throws counts as uncertain and still passes the gates before the ESC', async () => {
    const f = fixture();
    await expect(interruptChatTurn('conversation-1', { ...f.deps, native: async () => { throw new Error('socket'); } })).resolves.toBe('sent');
    expect(f.write).toHaveBeenCalledExactlyOnceWith('\x1b');
  });
});
