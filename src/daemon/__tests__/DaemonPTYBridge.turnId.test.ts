// Phone chat `turn.id`: one id per running episode. It changes only on an
// idle/settled -> running transition, never on a tool hook, an approval answer
// or a submit typed into the running turn. Replays the daemon's wiring: hooks
// go to `noteAgentStatus(status, true)`, every stdin write to `noteInput`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { PromptEventLog } from '../PromptEventLog';
import { RingBuffer } from '../RingBuffer';

const BIG = 'x'.repeat(3000); // > ActivityMonitor's 2 KB active threshold

function makeFakePty(): { pty: IPty; feed: (data: string) => void } {
  let dataHandler: ((data: string) => void) | null = null;
  const pty = {
    onData: (cb: (data: string) => void) => {
      dataHandler = cb;
      return { dispose: () => { dataHandler = null; } };
    },
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as IPty;
  return { pty, feed: (data: string) => dataHandler?.(data) };
}

describe('DaemonPTYBridge — running-episode turn id', () => {
  let bridge: DaemonPTYBridge;
  let feed: (data: string) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = new DaemonPTYBridge();
    const fake = makeFakePty();
    feed = fake.feed;
    bridge.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-1', new PromptEventLog());
  });

  afterEach(() => {
    bridge.cleanup();
    vi.useRealTimers();
  });

  const turn = () => bridge.getTurn(bridge.getAgentStatus());

  it('stays fixed across tool hooks and an approval answer, and changes on the next prompt', () => {
    bridge.noteInput('fix the tests\r');
    const first = turn();
    expect(first.id).toMatch(/^t1:/);
    expect(first.startedAt).toBe(Date.now());
    vi.advanceTimersByTime(100);
    feed(BIG);
    expect(turn()).toEqual({ ...first, state: 'running' });

    for (let i = 0; i < 3; i++) { // UserPromptSubmit, PreToolUse, PostToolUse ...
      bridge.noteAgentStatus('running', true);
      vi.advanceTimersByTime(500);
      expect(turn().id).toBe(first.id);
    }

    // A permission dialog mid-turn, answered with a lone digit.
    bridge.noteAgentStatus('awaiting_input', true);
    expect(turn()).toMatchObject({ id: first.id, state: 'running' });
    bridge.noteInput('1');
    expect(bridge.isAwaitingHuman()).toBe(false);
    bridge.noteAgentStatus('running', true);
    expect(turn().id).toBe(first.id);

    // A prompt typed into the running turn is the agent's own queue, not a turn.
    vi.advanceTimersByTime(100);
    feed(BIG);
    expect(bridge.getAgentStatus()).toBe('running');
    bridge.noteInput('also this\r');
    expect(turn().id).toBe(first.id);

    // Stop hook: the episode closes but keeps its id until something new starts.
    bridge.noteAgentStatus('complete', true);
    expect(turn()).toEqual({ ...first, state: 'idle' });

    vi.advanceTimersByTime(1000);
    bridge.noteInput('next task\r');
    const second = turn();
    expect(second.id).not.toBe(first.id);
    expect(second.startedAt).toBeGreaterThan(first.startedAt ?? Infinity);
  });

  it('opens a new episode on the first running edge after a settle: a hook or a byte promotion', () => {
    bridge.noteInput('go\r');
    const first = turn().id;
    bridge.noteAgentStatus('complete', true);

    // An autonomous turn announced by a hook.
    bridge.noteAgentStatus('running', true);
    const byHook = turn().id;
    expect(byHook).not.toBe(first);
    bridge.noteAgentStatus('running', true);
    expect(turn().id).toBe(byHook);

    // An autonomous turn seen only as bytes, past the settle cool-down.
    bridge.noteAgentStatus('complete', true);
    vi.advanceTimersByTime(6100);
    feed(BIG);
    expect(bridge.getAgentStatus()).toBe('running');
    expect(turn().id).not.toBe(byHook);
    expect(turn().state).toBe('running');
  });

  it('a recorded transcript end (an interrupt fires no Stop hook) closes the episode', () => {
    bridge.noteInput('long task\r');
    vi.advanceTimersByTime(100);
    feed(BIG);
    const first = turn();
    // An end recorded before the current turn started is ignored.
    bridge.noteTranscriptTurnEnd((first.startedAt ?? 0) - 1);
    expect(turn().state).toBe('running');

    vi.advanceTimersByTime(200);
    bridge.noteTranscriptTurnEnd(Date.now());
    expect(turn()).toEqual({ ...first, state: 'idle' });
    // The pane still paints its tail, but a prompt now starts a new episode.
    expect(bridge.getAgentStatus()).toBe('running');
    bridge.noteInput('try again\r');
    expect(turn().id).not.toBe(first.id);
  });

  it('never repeats an id from another bridge lifetime (daemon restart)', () => {
    const other = new DaemonPTYBridge();
    expect(other.getTurn('idle').id).not.toBe(bridge.getTurn('idle').id);
    expect(bridge.getTurn('idle')).toEqual({ id: expect.stringMatching(/^t1:/), state: 'idle' });
    other.cleanup();
  });

  it('records the last lone Esc from every write path', () => {
    expect(bridge.getLastEscAt()).toBe(0);
    vi.advanceTimersByTime(1000);
    bridge.noteInput('\x1b'); // pipe / web raw input / chat Stop
    const t1 = Date.now();
    expect(bridge.getLastEscAt()).toBe(t1);

    vi.advanceTimersByTime(1000);
    bridge.noteInput('\x1b[A'); // an arrow key is not a lone Esc
    bridge.noteInput('a');
    bridge.noteInput('\x1b\r');
    expect(bridge.getLastEscAt()).toBe(t1);

    vi.advanceTimersByTime(1000);
    bridge.noteInput('\x1b', true); // approval controls (forceSubmitted)
    expect(bridge.getLastEscAt()).toBe(Date.now());

    vi.advanceTimersByTime(1000);
    bridge.noteInput('\x1b[I\x1b'); // glued to a focus report
    expect(bridge.getLastEscAt()).toBe(Date.now());
  });
});
