// M3 A1: a chunk's bytes go to the ring and the session pipe first; its text
// analysis (detector, activity, interpreter/OSC, cwd) runs after, chunk by
// chunk in arrival order. These pin what must not change when that analysis
// waits: every outcome here is today's, with the analysis no longer running
// inside the PTY callback. `settle()` lets a pending drain run; on a bridge
// that analyses inline it changes nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { PromptEventLog } from '../PromptEventLog';
import { RingBuffer } from '../RingBuffer';
import { OutputInterpreter } from '../OutputInterpreter';
import type { AgentSignal } from '../../shared/hooks/signal-types';

const BIG = 'x'.repeat(3000); // over ActivityMonitor's 2 KB active threshold
const APPROVAL = 'Would you like to run the following command?\r\n';
const SHELL_RETURN = '\x1b]133;D;0\x07\x1b]133;A\x07';
const CODEX_BANNER = '\x1b[9;1H│ >_ OpenAI Codex (v0.149.1)            │\r\n';
const CODEX_MODES = '\x1b[?2004h\x1b[?1049h';
const T0 = 100_000;

function fakePty() {
  let data: ((chunk: string) => void) | null = null;
  let exit: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  return {
    pty: {
      onData: (cb: (chunk: string) => void) => { data = cb; return { dispose: () => { data = null; } }; },
      onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => { exit = cb; return { dispose: () => { exit = null; } }; },
      write: () => undefined,
    } as unknown as IPty,
    feed: (chunk: string) => data?.(chunk),
    exit: () => exit?.({ exitCode: 0 }),
  };
}

type Ev = [name: string, detail: string];

describe('DaemonPTYBridge: bytes first, analysis after, in order', () => {
  let bridge: DaemonPTYBridge;
  let pty: ReturnType<typeof fakePty>;
  let ring: RingBuffer;
  let log: PromptEventLog;
  let events: Ev[];

  const settle = () => vi.advanceTimersByTime(0);
  const signal = (over: Partial<AgentSignal> = {}): AgentSignal => ({
    kind: 'agent.activity', agent: 'codex', ptyId: 'pane-a', cwd: '/repo', ts: Date.now(), payload: {}, ...over,
  });
  /** The detector's trusted owner, read without flushing anything. */
  const trusted = () => (bridge as unknown as { agentDetector: { getTrustedAgent(): string | null } }).agentDetector.getTrustedAgent();
  const statuses = (status: string) => events.filter(([n, d]) => n === 'agent' && d === status).length;

  function record(b: DaemonPTYBridge): void {
    b.on('agent', (e: { event: { status: string } }) => events.push(['agent', e.event.status]));
    b.on('active', () => events.push(['active', '']));
    b.on('idle', (e: { preTurn?: boolean }) => events.push(['idle', e.preTurn ? 'preTurn' : '']));
    b.on('prompt', (e: { event: { type: string } }) => events.push(['prompt', e.event.type]));
    b.on('title', (e: { title: string }) => events.push(['title', e.title]));
    b.on('cwd', (e: { cwd: string }) => events.push(['cwd', e.cwd]));
    b.on('critical', () => events.push(['critical', '']));
    b.on('exit', () => events.push(['exit', '']));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    bridge = new DaemonPTYBridge();
    pty = fakePty();
    ring = new RingBuffer(65536);
    log = new PromptEventLog();
    events = [];
    record(bridge);
    bridge.setupDataForwarding(pty.pty, ring, 'pane-a', log);
    // A process observation must postdate the bridge's start (identityLifetimeAt).
    vi.advanceTimersByTime(1);
  });
  afterEach(() => { bridge.cleanup(); vi.useRealTimers(); });

  // 1. Readers inside the analysis see the detector's view of the same chunk.
  it('a Codex banner in the chunk that opens the gate marks the boot silence pre-turn', () => {
    pty.feed(CODEX_MODES + CODEX_BANNER + BIG);
    pty.feed('tail of the boot paint');
    settle();
    vi.advanceTimersByTime(5000);
    expect(events.filter(([n]) => n === 'idle')).toEqual([['idle', 'preTurn']]);
  });

  // 2. A chunk's terminal edge lands before the next chunk's bytes are counted.
  it('a burst right behind a dialog in the same tick does not retire the "needs you"', () => {
    bridge.noteAgentProcess({ slug: 'codex', alive: true, observedAt: Date.now() });
    pty.feed(APPROVAL);
    pty.feed(BIG);
    settle();
    expect(statuses('awaiting_input')).toBe(1);
    expect(events.filter(([n]) => n === 'active')).toEqual([]);
    expect(bridge.isAwaitingHuman()).toBe(true);
  });

  // 3. State changes from outside the stream see every chunk that came before them.
  describe('input, hooks and probes between a chunk and its analysis', () => {
    it('an Enter after a dialog chunk answers it, and the dialog is not raised again', () => {
      bridge.noteAgentProcess({ slug: 'codex', alive: true, observedAt: Date.now() });
      pty.feed(APPROVAL);
      bridge.noteInput('\r');
      settle();
      expect(bridge.isAwaitingHuman()).toBe(false);
      expect(events.findIndex(([n, d]) => n === 'agent' && d === 'awaiting_input')).toBe(0);
      expect(statuses('awaiting_input')).toBe(1);
    });

    it('a hook identity taken after a shell return survives it', () => {
      pty.feed(SHELL_RETURN);
      vi.setSystemTime(T0 + 10);
      expect(bridge.noteHookAgentIdentity(signal(), { slug: 'codex', source: 'hook' })).toBe(true);
      settle();
      expect(trusted()).toBe('codex');
    });

    it('a probe observed before a shell return still waiting for analysis does not seed', () => {
      vi.setSystemTime(T0 + 10);
      pty.feed(SHELL_RETURN);
      bridge.noteAgentProcess({ slug: 'codex', alive: true, observedAt: T0 + 5 });
      settle();
      expect(trusted()).toBeNull();
    });

    it('a key typed after a burst on a settled pane does not hide the burst it followed', () => {
      bridge.noteAgentStatus('waiting', true);
      vi.advanceTimersByTime(6100); // past the settle cool-down and the input/resize guards
      pty.feed(BIG);
      bridge.noteInput('a');
      settle();
      expect(events.filter(([n]) => n === 'active')).toHaveLength(1);
    });

    it('typing after a prompt mark still waiting for analysis leaves the prompt not empty', () => {
      pty.feed('\x1b]133;B\x07');
      bridge.noteInput('draft');
      settle();
      expect(bridge.isEmptyShellPrompt()).toBe(false);
    });

    it('a probe observed after a shell return, read later, still seeds', () => {
      pty.feed(SHELL_RETURN);
      vi.setSystemTime(T0 + 50);
      bridge.noteAgentProcess({ slug: 'codex', alive: true, observedAt: T0 + 20 });
      settle();
      expect(trusted()).toBe('codex');
    });
  });

  // 4. Exit, data after exit, respawn, mute.
  describe('exit, respawn and mute', () => {
    it('output analysed before exit is reported before exit, and nothing of it after', () => {
      pty.feed('\x1b]133;A\x07');
      pty.exit();
      const atExit = events.length;
      settle();
      expect(events).toEqual([['prompt', 'prompt_start'], ['exit', '']]);
      expect(events.length).toBe(atExit);
    });

    it('data the PTY delivers after its exit is still analysed', () => {
      pty.exit();
      pty.feed('\x1b]133;A\x07');
      settle();
      expect(events).toContainEqual(['prompt', 'prompt_start']);
      expect(log.recent(1).map((e) => e.type)).toEqual(['prompt_start']);
    });

    it('a respawn analyses the old output against the old setup, not the new one', () => {
      pty.feed('\x1b]133;A\x07');
      const next = fakePty();
      const nextLog = new PromptEventLog();
      bridge.setupDataForwarding(next.pty, new RingBuffer(65536), 'pane-a', nextLog);
      settle();
      expect(log.recent(5).map((e) => e.type)).toEqual(['prompt_start']);
      expect(nextLog.size).toBe(0);
    });

    it('muted output is read by the detector only; the unmute replay is analysed once', () => {
      bridge.setMuted(true);
      pty.feed('\x1b]133;A\x07held');
      bridge.setMuted(false, { replayHeld: true });
      settle();
      expect(events.filter(([n]) => n === 'prompt')).toEqual([['prompt', 'prompt_start']]);
      expect(ring.readAll().toString()).toContain('held');
    });
  });

  // 6a. One analysis per chunk: when the analysis runs does not change what it finds.
  it('chunks analysed in one batch give the same events as chunks analysed one by one', () => {
    const stream = '\x1b]0;✳ Claude Code\x07\x1b]7;file://host/repo\x07' + APPROVAL + '\x1b]133;A\x07$ \x1b]133;B\x07' + BIG;
    const run = (cuts: number[], batched: boolean): Ev[] => {
      const b = new DaemonPTYBridge();
      const p = fakePty();
      events = [];
      record(b);
      b.setupDataForwarding(p.pty, new RingBuffer(65536), 'pane-a', new PromptEventLog());
      vi.advanceTimersByTime(1);
      b.noteAgentProcess({ slug: 'codex', alive: true, observedAt: Date.now() });
      let at = 0;
      for (const cut of [...cuts, stream.length]) {
        p.feed(stream.slice(at, cut));
        at = cut;
        if (!batched) settle();
      }
      settle();
      vi.advanceTimersByTime(5000);
      b.cleanup();
      return events;
    };
    for (let cut = 1; cut < stream.length - BIG.length; cut++) {
      expect(run([cut], true), `cut at ${cut}`).toEqual(run([cut], false));
    }
  });

  // 6b. A reader of the tracked modes sees every chunk already in the ring.
  it('the output modes include a chunk still waiting for analysis', () => {
    pty.feed('\x1b[?1049h');
    expect(bridge.outputModes?.isSet(1049)).toBe(true);
  });

  // 7. Prompt events keep their own chunk's offset and arrival time.
  it('OSC 133 events are logged at their chunk\'s byte offset and time', () => {
    const t = Date.now();
    pty.feed('a'.repeat(10) + '\x1b]133;A\x07'); // the mark is 8 bytes
    vi.setSystemTime(t + 50);
    pty.feed('b'.repeat(20) + '\x1b]133;B\x07');
    vi.setSystemTime(t + 200);
    expect(log.snapshot().map((e) => [e.type, e.byteOffset, e.ts])).toEqual([
      ['prompt_start', 18, t],
      ['prompt_end', 46, t + 50],
    ]);
  });

  // 8. A reader called from inside the analysis does not run the queue again.
  it('listeners that read the bridge mid-analysis see each chunk once, in order', () => {
    const failures = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const interpreted = vi.spyOn(OutputInterpreter.prototype, 'feed');
    const seen: string[] = [];
    bridge.on('prompt', (e: { event: { type: string } }) => {
      seen.push(e.event.type);
      bridge.getLastAgent();
      void bridge.outputModes;
      log.recent(5);
    });
    pty.feed('\x1b]133;A\x07');
    pty.feed('\x1b]133;B\x07');
    pty.feed('\x1b]133;C\x07');
    settle();
    expect(seen).toEqual(['prompt_start', 'prompt_end', 'command_start']);
    expect(failures).not.toHaveBeenCalled();
    expect(interpreted).toHaveBeenCalledTimes(3);
    failures.mockRestore();
    interpreted.mockRestore();
    expect(log.snapshot().map((e) => e.type)).toEqual(['prompt_start', 'prompt_end', 'command_start']);
  });

  // 9. The prompt log, read from outside the bridge, includes every chunk in the ring.
  it('a command start still waiting for analysis reads as running', () => {
    pty.feed('\x1b]133;C\x07');
    expect(log.commandRunningIfKnown()).toBe(true);
    expect(log.isCommandRunning()).toBe(true);
  });
});
