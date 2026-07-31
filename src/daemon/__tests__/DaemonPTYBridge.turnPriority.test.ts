// Turn-priority: which signal owns a pane's agent status.
//
// Two sources compete inside the daemon. Byte throughput (ActivityMonitor) is a
// heuristic — a full-screen TUI redraw looks exactly like work. A detector or
// hook lifecycle edge (waiting / complete / awaiting input) is authoritative.
// Before this, an idle Claude repaint five seconds after a Stop hook resurrected
// stale `running` metadata, so a pane that was actually blocked on a question
// reported itself as busy.
//
// The rule these lock:
//   1. An explicit terminal status SETTLES the turn. While settled, passive
//      bytes are ignored entirely.
//   2. Only a real submitted-input boundary (CR/LF outside bracketed paste, or
//      an explicit forceSubmitted control) re-opens the gate.
//   3. An explicit `running` edge also re-opens it (autonomous work).
//   4. Within one chunk, activity is processed FIRST so a terminal pattern found
//      in that same chunk is forwarded LAST and wins.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { RingBuffer } from '../RingBuffer';

const BIG = 'x'.repeat(3000); // > ActivityMonitor's 2 KB active threshold
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

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

describe('DaemonPTYBridge turn priority', () => {
  let bridge: DaemonPTYBridge;
  let feed: (data: string) => void;
  let idle: string[];
  let active: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = new DaemonPTYBridge();
    const fake = makeFakePty();
    feed = fake.feed;
    idle = [];
    active = [];
    bridge.on('idle', (e: { sessionId: string }) => idle.push(e.sessionId));
    bridge.on('active', (e: { sessionId: string }) => active.push(e.sessionId));
    bridge.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-1');
  });

  afterEach(() => {
    bridge.cleanup();
    vi.useRealTimers();
  });

  describe('baseline (unsettled pane)', () => {
    it('reports a passive burst as active and then idle', () => {
      feed(BIG);
      expect(active).toEqual(['sess-1']);
      vi.advanceTimersByTime(5000);
      expect(idle).toEqual(['sess-1']);
    });
  });

  describe('an explicit terminal status settles the turn', () => {
    it('suppresses the idle notification that would clear it', () => {
      feed(BIG);
      bridge.noteAgentStatus('waiting');
      vi.advanceTimersByTime(10_000);
      // The pane IS waiting; a byte-silence idle event five seconds later is
      // weaker evidence and must not overwrite it.
      expect(idle).toEqual([]);
    });

    it('ignores a later full-screen repaint entirely', () => {
      bridge.noteAgentStatus('complete');
      active.length = 0;
      feed(BIG);
      feed(BIG);
      vi.advanceTimersByTime(10_000);
      expect(active).toEqual([]);
      expect(idle).toEqual([]);
    });

    it.each(['waiting', 'complete', 'awaiting_input', 'error'] as const)(
      'treats %s as terminal',
      (status) => {
        bridge.noteAgentStatus(status);
        active.length = 0;
        feed(BIG);
        expect(active).toEqual([]);
      },
    );

    it('an explicit running edge re-opens the gate for autonomous work', () => {
      bridge.noteAgentStatus('complete');
      feed(BIG);
      expect(active).toEqual([]);

      bridge.noteAgentStatus('running');
      feed(BIG);
      expect(active).toEqual(['sess-1']);
    });
  });

  describe('noteInput — what counts as a submitted turn', () => {
    it('ordinary typing does NOT re-open the gate', () => {
      bridge.noteAgentStatus('waiting');
      bridge.noteInput('git st');
      feed(BIG);
      expect(active).toEqual([]);
    });

    it('a CR re-opens it, and the very first output byte reports running', () => {
      bridge.noteAgentStatus('waiting');
      bridge.noteInput('git status\r');
      feed('ok'); // 2 bytes — far below the 2 KB passive threshold
      expect(active).toEqual(['sess-1']);
    });

    it('an LF also counts as submitted', () => {
      bridge.noteAgentStatus('complete');
      bridge.noteInput('run\n');
      feed('.');
      expect(active).toEqual(['sess-1']);
    });

    it('newlines INSIDE a bracketed paste are inert (a draft, not a submit)', () => {
      bridge.noteAgentStatus('waiting');
      bridge.noteInput(`${PASTE_START}line one\nline two\n${PASTE_END}`);
      feed('.');
      expect(active).toEqual([]);
    });

    it('the CR that follows a pasted draft IS the submit (separate writes)', () => {
      bridge.noteAgentStatus('waiting');
      bridge.noteInput(`${PASTE_START}draft\nbody${PASTE_END}`);
      feed('.');
      expect(active).toEqual([]);

      bridge.noteInput('\r');
      feed('.');
      expect(active).toEqual(['sess-1']);
    });

    it('tracks an UNTERMINATED paste across writes and stays inert', () => {
      bridge.noteAgentStatus('waiting');
      bridge.noteInput(`${PASTE_START}first\n`);
      bridge.noteInput('second\n');
      feed('.');
      expect(active).toEqual([]);
    });

    it('a CR before the paste opens still counts (text outside the paste)', () => {
      bridge.noteAgentStatus('waiting');
      bridge.noteInput(`go\r${PASTE_START}later\n`);
      feed('.');
      expect(active).toEqual(['sess-1']);
    });

    it('forceSubmitted arms a control that carries no Enter (approval digit)', () => {
      // An approval answer is a bare "2" or ESC — no CR — yet it definitely
      // resumes the blocked turn.
      bridge.noteAgentStatus('awaiting_input');
      bridge.noteInput('2', true);
      feed('.');
      expect(active).toEqual(['sess-1']);
    });

    it('without forceSubmitted the same bare digit stays inert', () => {
      bridge.noteAgentStatus('awaiting_input');
      bridge.noteInput('2');
      feed('.');
      expect(active).toEqual([]);
    });
  });

  describe('same-chunk ordering', () => {
    it('a terminal status found in the SAME chunk is the final word', () => {
      const seen: string[] = [];
      bridge.on('active', () => seen.push('active'));
      bridge.on('agent', (e: { event: { status: string } }) => seen.push(`agent:${e.event.status}`));

      // A big Claude frame that both looks like heavy work AND contains the
      // idle-prompt footer. Activity must be emitted before the agent event so
      // the renderer's last write is the authoritative 'waiting'.
      feed(`Claude Code v2.1.172\n${BIG}\n  shift+tab to cycle modes\n`);

      const lastAgent = seen.filter((s) => s.startsWith('agent:')).at(-1);
      expect(lastAgent).toBe('agent:waiting');
      expect(seen.indexOf('active')).toBeLessThan(seen.lastIndexOf(lastAgent!));
    });

    it('the settle from that chunk suppresses the following idle', () => {
      feed(`Claude Code v2.1.172\n${BIG}\n  shift+tab to cycle modes\n`);
      vi.advanceTimersByTime(10_000);
      expect(idle).toEqual([]);
    });
  });

  describe('lifecycle reset', () => {
    it('cleanup() clears the settled state so a reused bridge starts fresh', () => {
      bridge.noteAgentStatus('waiting');
      bridge.cleanup();

      // cleanup() also calls removeAllListeners(), so a reused bridge has to be
      // re-subscribed — re-attach before asserting on the next session.
      const reused: string[] = [];
      bridge.on('active', (e: { sessionId: string }) => reused.push(e.sessionId));

      const fake = makeFakePty();
      bridge.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-2');
      fake.feed(BIG);
      expect(reused).toEqual(['sess-2']);
    });

    it('a fresh setupDataForwarding on a settled bridge also clears the gate', () => {
      // The reset is deliberately belt-and-braces: setupDataForwarding resets
      // too, so a session swap that skipped cleanup() cannot inherit a settle.
      bridge.noteAgentStatus('complete');
      active.length = 0;

      const fake = makeFakePty();
      bridge.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-3');
      fake.feed(BIG);
      expect(active).toEqual(['sess-3']);
    });
  });
});
