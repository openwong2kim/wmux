// #1463 — a freshly launched agent read Running for up to two minutes before
// anyone prompted it: its TUI boot burst lit the pane, and the byte-silence
// idle that followed was unmarked, so the renderer kept its 120 s running
// stamp. The bridge now says when that silence came before any turn, so main
// can settle it. Replays the daemon's own wiring: the SessionStart hook lands
// as an authoritative `running` edge followed by `noteSessionStart()`.
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
    onExit: () => ({ dispose: () => {} }),
  } as unknown as IPty;
  return { pty, feed: (data: string) => dataHandler?.(data) };
}

describe('DaemonPTYBridge — #1463 pre-turn silence', () => {
  let bridge: DaemonPTYBridge;
  let feed: (data: string) => void;
  let idle: Array<{ sessionId: string; preTurn?: boolean }>;

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = new DaemonPTYBridge();
    const fake = makeFakePty();
    feed = fake.feed;
    idle = [];
    bridge.on('idle', (e: { sessionId: string; preTurn?: boolean }) => idle.push(e));
    bridge.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-1', new PromptEventLog());
  });

  afterEach(() => {
    bridge.cleanup();
    vi.useRealTimers();
  });

  /** The daemon's hook wiring for SessionStart (daemon/index.ts emitAgentEvent). */
  function sessionStart(): void {
    bridge.noteAgentStatus('running', true);
    bridge.noteSessionStart();
  }

  it('marks the silence after a boot burst, and stops once a prompt is submitted', () => {
    bridge.noteInput('claude\r'); // the Enter that launched the agent
    vi.advanceTimersByTime(300);
    sessionStart();
    feed(BIG); // TUI boot paint
    vi.advanceTimersByTime(5000);
    expect(idle).toEqual([{ sessionId: 'sess-1', preTurn: true }]);

    bridge.noteInput('fix the tests\r'); // the first real turn
    vi.advanceTimersByTime(3100);
    feed(BIG);
    vi.advanceTimersByTime(5000);
    expect(idle.at(-1)).toEqual({ sessionId: 'sess-1' });
  });

  it('reports the agent idle prompt before any turn as pre-turn silence', () => {
    // Live: Claude's boot paint ends on its idle footer, the detector reports
    // `waiting`, and that status ends the byte cycle — no silence idle follows.
    const detector = (bridge as unknown as {
      agentDetector: { callbacks: Array<(e: { agent: string; status: string; message: string }) => void> };
    }).agentDetector;
    const detect = (status: string) =>
      detector.callbacks.forEach((cb) => cb({ agent: 'Claude Code', status, message: '' }));

    bridge.noteInput('claude\r');
    vi.advanceTimersByTime(300);
    sessionStart();
    feed(BIG);
    detect('waiting');
    expect(idle).toEqual([{ sessionId: 'sess-1', preTurn: true }]);

    // After a submitted prompt the same footer is a turn's end, not a boot.
    vi.advanceTimersByTime(2000);
    bridge.noteInput('fix the tests\r');
    vi.advanceTimersByTime(100);
    detect('waiting');
    expect(idle).toHaveLength(1);
  });

  it('never marks silence on a pane whose agent reported no session start', () => {
    bridge.noteInput('codex\r');
    feed(BIG);
    vi.advanceTimersByTime(5000);
    expect(idle).toEqual([{ sessionId: 'sess-1' }]);
  });
});
