// Claude Code fires no Stop hook for an interrupted turn. The bridge reports
// the agent's own "Interrupted" row so main can settle the pane, but that row
// stays in the transcript: one printed again by a resize redraw belongs to an
// old turn and must not settle the current one.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { PromptEventLog } from '../PromptEventLog';
import { RingBuffer } from '../RingBuffer';
import { RESIZE_REDRAW_GUARD_MS } from '../../main/notification/idleSuppression';

const ROW = '  ⎿  Interrupted · What should Claude do instead?\r\n';

function makeFakePty(): { pty: IPty; feed: (data: string) => void } {
  let dataHandler: ((data: string) => void) | null = null;
  const pty = {
    onData: (cb: (data: string) => void) => {
      dataHandler = cb;
      return { dispose: () => { dataHandler = null; } };
    },
    onExit: () => ({ dispose: () => {} }),
  } as unknown as IPty;
  return { pty, feed: (data: string) => dataHandler?.(data) };
}

describe('DaemonPTYBridge — interrupted-turn row', () => {
  let bridge: DaemonPTYBridge;
  let feed: (data: string) => void;
  let interrupted: Array<{ sessionId: string; agent: string }>;

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = new DaemonPTYBridge();
    const fake = makeFakePty();
    feed = fake.feed;
    interrupted = [];
    bridge.on('turnInterrupted', (e: { sessionId: string; agent: string }) => interrupted.push(e));
    bridge.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-1', new PromptEventLog());
    feed('Claude Code v2.1.300\r\n  bypass permissions on\r\n'); // opens the Claude gate
  });

  afterEach(() => {
    bridge.cleanup();
    vi.useRealTimers();
  });

  it('reports the row the agent prints after an interrupt', () => {
    vi.advanceTimersByTime(RESIZE_REDRAW_GUARD_MS);
    feed(ROW);
    expect(interrupted).toEqual([{ sessionId: 'sess-1', agent: 'Claude Code' }]);
  });

  describe('the turn it ends', () => {
    let edges: Array<number | null>;
    beforeEach(() => {
      edges = [];
      bridge.on('agentTurn', (p: { runningSince: number | null }) => edges.push(p.runningSince));
      vi.advanceTimersByTime(RESIZE_REDRAW_GUARD_MS);
      bridge.noteInput('fix the build\r');
      bridge.noteAgentStatus('running', true); // UserPromptSubmit
      vi.advanceTimersByTime(10);
      expect(bridge.isAgentMidTurn()).toBe(true);
    });

    it('this turn\'s Esc and its row end the open agent turn: no Stop hook follows an interrupt', () => {
      bridge.noteInput('\x1b');
      feed(ROW);
      expect(bridge.isAgentMidTurn()).toBe(false);
      expect(edges).toEqual([edges[0], null]);
    });

    it('a row reprinted with no Esc of this turn leaves the turn open', () => {
      feed(ROW);
      expect(bridge.isAgentMidTurn()).toBe(true);
      expect(edges).toHaveLength(1);
    });

    it('an interrupt behind a dialog still ends the turn the dialog belonged to', () => {
      bridge.noteAgentStatus('awaiting_input', true); // a permission prompt
      expect(bridge.isAgentMidTurn()).toBe(true);
      // The agent's own interrupt (no key, so the dialog is not answered first).
      bridge.noteInterrupt();
      feed(ROW);
      expect(bridge.isAgentMidTurn()).toBe(false);
      expect(edges).toEqual([edges[0], null]);
    });
  });

  it('ignores the row inside a resize redraw', () => {
    bridge.noteResize();
    feed(ROW);
    expect(interrupted).toEqual([]);
  });

  // #2264 — an Esc while Claude Code is still thinking draws no row; its title
  // turning from the running spinner to `✳` is the only sign the turn ended
  // (frames from a live 2.1.301 capture).
  describe('title turning idle after a lone Esc', () => {
    const BUSY = '\u001b]0;◑ 50번째 소수 검증\u0007';
    const IDLE = '\u001b]0;✳ 50번째 소수 검증\u0007';

    beforeEach(() => {
      vi.advanceTimersByTime(RESIZE_REDRAW_GUARD_MS);
      feed(BUSY);
    });

    it('reports the edge that follows a lone Esc', () => {
      bridge.noteInput('\x1b');
      vi.advanceTimersByTime(84);
      feed(IDLE);
      expect(interrupted).toEqual([{ sessionId: 'sess-1', agent: 'Claude Code' }]);
    });

    it('does not report a turn that ran its Stop hooks, even right after an Esc', () => {
      bridge.noteInput('\x1b');
      vi.advanceTimersByTime(600);
      feed('\u001b[38;2;153;153;153m\u001b[2Crunning Stop hook · 3s · \u001b[m');
      vi.advanceTimersByTime(300);
      feed(IDLE);
      expect(interrupted).toEqual([]);
    });

    it('reports one idle title per Esc', () => {
      bridge.noteInput('\x1b');
      vi.advanceTimersByTime(84);
      feed(IDLE);
      // The next turn starts and ends inside the same Esc window.
      vi.advanceTimersByTime(500);
      feed(BUSY);
      vi.advanceTimersByTime(500);
      feed(IDLE);
      expect(interrupted).toEqual([{ sessionId: 'sess-1', agent: 'Claude Code' }]);
    });

    it('does not report an ordinary turn end (no Esc before it)', () => {
      feed(IDLE);
      expect(interrupted).toEqual([]);
    });

    it('does not report an edge after the Esc window has passed', () => {
      bridge.noteInput('\x1b');
      vi.advanceTimersByTime(3_000);
      feed(IDLE);
      expect(interrupted).toEqual([]);
    });

    it('reports an idle title after an Esc that came before the first running title', () => {
      feed(IDLE);
      expect(interrupted).toEqual([]);
      bridge.noteInput('\x1b');
      vi.advanceTimersByTime(100);
      feed(IDLE);
      expect(interrupted).toEqual([{ sessionId: 'sess-1', agent: 'Claude Code' }]);
    });

    it('ignores the edge inside a resize redraw', () => {
      bridge.noteInput('\x1b');
      bridge.noteResize();
      feed(IDLE);
      expect(interrupted).toEqual([]);
    });
  });

  // Declining an AskUserQuestion (or rejecting a permission prompt) with Esc
  // ends Claude Code's turn with no Stop hook and no `Interrupted` row; the
  // transcript's `[Request interrupted by user for tool use]` is the only
  // record. Live: the pane went back to running on the answer and stayed so.
  describe('Esc that closes a dialog', () => {
    let endedAt: number | undefined;
    let edges: Array<number | null>;

    beforeEach(() => {
      endedAt = undefined;
      DaemonPTYBridge.transcriptTurnEndProbe = () => endedAt;
      edges = [];
      bridge.on('agentTurn', (p: { runningSince: number | null }) => edges.push(p.runningSince));
      vi.advanceTimersByTime(RESIZE_REDRAW_GUARD_MS);
      bridge.noteInput('add a pause switch\r');
      bridge.noteAgentStatus('running', true); // UserPromptSubmit
      vi.advanceTimersByTime(10);
      bridge.noteAgentStatus('awaiting_input', true, Date.now()); // the question
      vi.advanceTimersByTime(30_000);
    });

    afterEach(() => {
      DaemonPTYBridge.transcriptTurnEndProbe = null;
    });

    it('ends the turn once the transcript records the interrupt', () => {
      bridge.noteInput('\x1b');
      expect(bridge.isAgentMidTurn()).toBe(true);
      vi.advanceTimersByTime(800);
      endedAt = Date.now();
      vi.advanceTimersByTime(500);
      expect(bridge.isAgentMidTurn()).toBe(false);
      expect(edges.at(-1)).toBeNull();
      expect(interrupted).toEqual([{ sessionId: 'sess-1', agent: 'Claude Code' }]);
    });

    it('leaves the turn running when the transcript records no end', () => {
      bridge.noteInput('\x1b');
      vi.advanceTimersByTime(5_000);
      expect(bridge.isAgentMidTurn()).toBe(true);
      expect(interrupted).toEqual([]);
    });

    it('ignores an end recorded before the Esc', () => {
      endedAt = Date.now() - 5_000;
      bridge.noteInput('\x1b');
      vi.advanceTimersByTime(5_000);
      expect(bridge.isAgentMidTurn()).toBe(true);
      expect(interrupted).toEqual([]);
    });

    it('does not read the transcript for a digit answer', () => {
      bridge.noteInput('1');
      endedAt = Date.now();
      vi.advanceTimersByTime(5_000);
      expect(interrupted).toEqual([]);
    });
  });
});
