// Turn-priority: which signal owns a pane's agent status.
//
// Two sources compete inside the daemon. Byte throughput (ActivityMonitor) is a
// heuristic — a full-screen TUI redraw looks exactly like work. A detector or
// hook lifecycle edge (waiting / complete / awaiting input) is authoritative.
// Before this, an idle Claude repaint five seconds after a Stop hook resurrected
// stale `running` metadata, so a pane that was actually blocked on a question
// reported itself as busy. The settle that fixed it was absolute, which bought
// the opposite error (#935): a turn the agent started by itself wore the
// previous turn's `complete` for its whole length.
//
// The rule these lock:
//   1. An explicit terminal status SETTLES the turn.
//   2. A real submitted-input boundary (CR/LF outside bracketed paste, or an
//      explicit forceSubmitted control) re-opens the gate.
//   3. An explicit `running` edge also re-opens it.
//   4. A burst of passive bytes re-opens it too (#935) — but only one that
//      cleared the threshold from a cycle the turn end re-armed, with the
//      user's keystrokes quiet and outside the resize-redraw window. Those
//      three conditions are what separate a turn the agent started BY ITSELF
//      from the pane echoing a draft message and from a repaint.
//   5. `awaiting_input` is exempt from 4: only a human retires a question.
//   6. Within one chunk, activity is processed FIRST so a terminal pattern found
//      in that same chunk is forwarded LAST and wins.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { RingBuffer } from '../RingBuffer';

const BIG = 'x'.repeat(3000); // > ActivityMonitor's 2 KB active threshold
// Past the settle cool-down (6 s) and the typing-echo quiet window (3 s).
const PAST_GUARDS_MS = 6100;
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

    it('ignores a repaint a resize explains', () => {
      bridge.noteAgentStatus('complete');
      active.length = 0;
      vi.advanceTimersByTime(PAST_GUARDS_MS);
      bridge.noteResize();
      feed(BIG);
      feed(BIG);
      vi.advanceTimersByTime(10_000);
      expect(active).toEqual([]);
      expect(idle).toEqual([]);
    });

    it.each(['waiting', 'complete', 'error'] as const)(
      'treats %s as terminal until a burst contradicts it',
      (status) => {
        bridge.noteAgentStatus(status);
        active.length = 0;
        vi.advanceTimersByTime(PAST_GUARDS_MS);
        feed('.');           // dribble stays under the threshold
        expect(active).toEqual([]);
        feed(BIG);           // a real burst is the agent working again
        expect(active).toEqual(['sess-1']);
      },
    );

    it('stays settled for the whole cool-down, however much it repaints', () => {
      // The cool-down is not just about the tail. The status a promotion writes
      // is cleared by the byte-silence idle 5 s later, and main drops that idle
      // within 10 s of the pane's last lifecycle event — so a promotion earlier
      // than 6 s can leave the pane stuck reporting `running` after it
      // finished. Re-arming (not consuming) the cycle is what lets the burst
      // after the cool-down still be heard.
      bridge.noteAgentStatus('complete');
      active.length = 0;
      for (let t = 0; t < 5500; t += 500) {
        feed(BIG);
        vi.advanceTimersByTime(500);
      }
      expect(active).toEqual([]);

      vi.advanceTimersByTime(1000);
      feed(BIG);
      expect(active).toEqual(['sess-1']);
    });

    it('holds the tail of the turn that just ended below the cool-down', () => {
      // A turn keeps painting after its Stop hook — the summary line, the
      // footer, the cursor restore. Promoting on that would report a finished
      // pane as running AND rebut the completion alarm's open window.
      bridge.noteAgentStatus('complete');
      active.length = 0;
      feed(BIG);
      feed(BIG);
      expect(active).toEqual([]);

      vi.advanceTimersByTime(PAST_GUARDS_MS);
      feed(BIG);
      expect(active).toEqual(['sess-1']);
    });

    it('never lets bytes retire awaiting_input — only a human does', () => {
      // A pane holding a question stays in the "needs you" count however much
      // a subagent paints behind the prompt. Answering it is what ends it.
      bridge.noteAgentStatus('awaiting_input');
      active.length = 0;
      vi.advanceTimersByTime(PAST_GUARDS_MS);
      feed(BIG);
      feed(BIG);
      vi.advanceTimersByTime(10_000);
      expect(active).toEqual([]);

      bridge.noteInput('2', true);
      feed('.');
      expect(active).toEqual(['sess-1']);
    });

    it('an explicit running edge re-opens the gate for autonomous work', () => {
      // The point here is the hook edge, so keep the bytes below the threshold
      // that would open the gate on its own (see the #935 block for that path).
      bridge.noteAgentStatus('complete');
      feed('.');
      expect(active).toEqual([]);

      bridge.noteAgentStatus('running');
      feed('.');
      expect(active).toEqual([]);   // still under the threshold, but ungated
      feed(BIG);
      expect(active).toEqual(['sess-1']);
    });
  });

  describe('a turn the agent starts by itself (#935)', () => {
    // The shape from the report: the agent launches a background task, ends its
    // turn, and the task's completion resumes it. There is no submitted input,
    // and on a hook install without PostToolUse there is no running edge
    // either — so before this the pane wore `complete` for the whole turn.
    it('reports running when the resumed turn produces real output', () => {
      bridge.noteAgentStatus('complete');
      active.length = 0;
      vi.advanceTimersByTime(PAST_GUARDS_MS);
      feed(BIG);
      expect(active).toEqual(['sess-1']);
    });

    it('keeps the exemption across a running edge nobody human produced', () => {
      // HookIngest projects `agent.subagent_stop` and every metadata kind as
      // `running`, so those edges arrive with the question still unanswered.
      // Such an edge opens the gate (its own status broadcast has already
      // moved the pane, which this change does not alter), but it must not
      // ERASE the fact that a human is owed an answer: once the pane settles
      // again, bytes still may not retire it.
      bridge.noteAgentStatus('awaiting_input');
      bridge.noteAgentStatus('running');       // e.g. a subagent finished
      bridge.noteAgentStatus('complete');      // and the pane settles again
      active.length = 0;
      vi.advanceTimersByTime(PAST_GUARDS_MS);
      feed(BIG);
      feed(BIG);
      expect(active).toEqual([]);

      bridge.noteInput('2', true);             // the human finally answers
      feed('.');
      expect(active).toEqual(['sess-1']);
    });

    it('keeps the exemption when the footer under an approval box says waiting', () => {
      // The Claude idle-prompt patterns still match while a question is on
      // screen, so `settledStatus` alone would be downgraded to `waiting` and
      // the pane would become promotable — silently dropping a real approval
      // out of the "needs you" count.
      bridge.noteAgentStatus('awaiting_input');
      bridge.noteAgentStatus('waiting');
      active.length = 0;
      vi.advanceTimersByTime(PAST_GUARDS_MS);
      feed(BIG);
      feed(BIG);
      expect(active).toEqual([]);
    });

    it('needs a NEW burst, not the one still in flight at the turn end', () => {
      // endTurn() zeroes the window at the boundary, so bytes that were already
      // counted toward the finishing turn cannot be spent again on the next one.
      feed('y'.repeat(1900));           // just under the threshold
      bridge.noteAgentStatus('complete');
      active.length = 0;
      vi.advanceTimersByTime(PAST_GUARDS_MS);
      feed('y'.repeat(200));            // would have crossed 2 KB cumulatively
      expect(active).toEqual([]);
      feed(BIG);
      expect(active).toEqual(['sess-1']);
    });

    it('does not reset the detector dedup, so idle chrome cannot answer back', () => {
      // A full resetEmissionState() here would let the footer still on screen
      // re-emit `waiting` right after the pane recorded `complete` — trading a
      // silently wrong status for a loudly wrong one.
      const statuses: string[] = [];
      bridge.on('agent', (e: { event: { status: string } }) => statuses.push(e.event.status));
      feed('Claude Code v2.1.172\n  shift+tab to cycle modes\n');
      statuses.length = 0;

      bridge.noteAgentStatus('complete');
      vi.advanceTimersByTime(PAST_GUARDS_MS);
      feed(BIG);
      feed('  shift+tab to cycle modes\n');
      expect(statuses).toEqual([]);
    });
  });

  describe('typing echo never counts as work', () => {
    it('suppresses a burst that arrives while the user is still typing', () => {
      bridge.noteAgentStatus('complete');
      active.length = 0;
      vi.advanceTimersByTime(PAST_GUARDS_MS);
      bridge.noteInput('draft message');   // no CR — still composing
      feed(BIG);
      expect(active).toEqual([]);
    });

    it('accepts the same burst once the keystrokes have gone quiet', () => {
      bridge.noteAgentStatus('complete');
      active.length = 0;
      vi.advanceTimersByTime(PAST_GUARDS_MS);
      bridge.noteInput('draft message');
      feed(BIG);
      expect(active).toEqual([]);

      vi.advanceTimersByTime(PAST_GUARDS_MS);   // past INPUT_ECHO_QUIET_MS
      feed(BIG);
      expect(active).toEqual(['sess-1']);
    });

    it('hands the cycle back so the real turn behind the echo still reports', () => {
      // A rejected burst must not spend the one onActive a cycle gets. Output
      // here never goes quiet for the five seconds the idle timer needs, so a
      // consumed cycle would keep the pane silent for the whole next turn.
      bridge.noteAgentStatus('complete');
      active.length = 0;
      vi.advanceTimersByTime(PAST_GUARDS_MS);
      bridge.noteInput('x');
      feed(BIG);                            // rejected: echo
      expect(active).toEqual([]);

      vi.advanceTimersByTime(PAST_GUARDS_MS);
      feed(BIG);                            // same cycle would be spent already
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

  describe('resize-redraw repaint flag on active events', () => {
    // review-team [2-MODEL] catch: the alarm's working feed consumes
    // session:active, so a TUI repaint right after a resize would rebut a
    // pending completion window and silently kill a real "finished" alarm.
    // The flag lets daemon/index.ts skip ONLY the alarm feed — the loose
    // status dot still updates.
    it('flags a passive burst inside the guard window, clears it after', () => {
      const payloads: Array<{ sessionId: string; likelyRepaint?: boolean }> = [];
      bridge.on('active', (e: { sessionId: string; likelyRepaint?: boolean }) => payloads.push(e));

      bridge.noteResize();
      feed(BIG);
      expect(payloads).toEqual([{ sessionId: 'sess-1', agentName: undefined, likelyRepaint: true }]);

      // Idle out, then a burst AFTER the guard window is real output.
      vi.advanceTimersByTime(5_000 + 100);
      feed(BIG);
      expect(payloads[1]).toMatchObject({ sessionId: 'sess-1', likelyRepaint: false });
    });

    it('never flags a burst started by submitted input', () => {
      const payloads: Array<{ sessionId: string; likelyRepaint?: boolean }> = [];
      bridge.on('active', (e: { sessionId: string; likelyRepaint?: boolean }) => payloads.push(e));

      bridge.noteResize();
      bridge.noteInput('\r');
      feed(BIG);
      expect(payloads).toEqual([{ sessionId: 'sess-1', agentName: undefined, likelyRepaint: false }]);
    });
  });
});
