// #2673 — Claude Code relaunched in a pane that already ran it (`/exit`, then
// `claude` again). The tracker still watched the previous Claude's pid, which
// the process monitor reported dead a few seconds after the new splash had
// opened the detector gate. That death edge ended the pane's agent: it cleared
// the new launch's screen identity, and with no launch edge for the new
// process nothing opened the gate again. The new turn's "Interrupted" row was
// never read, so Esc settled nothing (Windows, 11 instrumented runs).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { AgentProcessTracker, type PidWatcher, type ProcessTreeEntry, type TrackedAgentState } from '../AgentProcessTracker';
import { RingBuffer } from '../RingBuffer';
import { PromptEventLog } from '../PromptEventLog';
import { RESIZE_REDRAW_GUARD_MS } from '../../main/notification/idleSuppression';

const PROMPT = '\x1b]133;A\x07$ \x1b]133;B\x07';
const COMMAND_START = '\x1b]133;C\x07';
const COMMAND_END = '\x1b]133;D;0\x07';
const SHELL_RETURN = COMMAND_END + PROMPT;
const SPLASH = 'Claude Code v2.1.310\r\n  bypass permissions on\r\n';
const ROW = '  ⎿  Interrupted · What should Claude do instead?\r\n';
const SHELL_PID = 100;
const SHELL: ProcessTreeEntry = { pid: SHELL_PID, ppid: 1, name: 'zsh' };
const claudeProcess = (pid: number): ProcessTreeEntry => ({ pid, ppid: SHELL_PID, name: 'claude' });

function fakePty() {
  let data: ((chunk: string) => void) | null = null;
  return {
    pty: {
      onData: (cb: (chunk: string) => void) => { data = cb; return { dispose: () => { data = null; } }; },
      onExit: () => ({ dispose: () => undefined }),
    } as unknown as IPty,
    // The bridge analyses a chunk after forwarding it (M3 A1): one turn of
    // the (fake) event loop lets that analysis run, as it did inside the call.
    feed: (chunk: string) => { data?.(chunk); vi.advanceTimersByTime(0); },
  };
}

describe('a relaunched Claude Code keeps its identity through its predecessor\'s death edge', () => {
  let bridge: DaemonPTYBridge;
  let pty: ReturnType<typeof fakePty>;
  let tracker: AgentProcessTracker;
  let processes: ProcessTreeEntry[];
  let onDead: Map<number, () => void>;
  let edges: TrackedAgentState[];
  let interrupted: number;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    bridge = new DaemonPTYBridge();
    pty = fakePty();
    bridge.setupDataForwarding(pty.pty, new RingBuffer(65536), 'pane-a', new PromptEventLog());
    interrupted = 0;
    bridge.on('turnInterrupted', () => { interrupted += 1; });
    processes = [SHELL];
    onDead = new Map();
    edges = [];
    const watcher: PidWatcher = {
      watch: (_key, pid, dead) => { onDead.set(pid, dead); },
      unwatch: () => undefined,
    };
    tracker = new AgentProcessTracker(watcher, async () => processes);
    // The daemon's wiring (index.ts): the guard captures the detector epoch,
    // and every state change reaches the bridge.
    tracker.setIdentityProbeGuard(() => bridge.captureIdentityProbe());
    tracker.setLaunchCounter(() => bridge.getCommandStarts());
    tracker.setStateChangeListener((_id, state) => {
      edges.push(state);
      bridge.noteAgentProcess(state);
    });
    vi.advanceTimersByTime(1);
  });

  afterEach(() => {
    tracker.disarm('pane-a');
    bridge.cleanup();
    vi.useRealTimers();
  });

  /** `claude` typed at the shell prompt; `markers` precede the splash in the same read when given. */
  function launch(markers?: string): void {
    bridge.noteInput('claude\r');
    if (markers !== undefined) {
      pty.feed(markers + SPLASH);
    } else {
      pty.feed(COMMAND_START);
      vi.advanceTimersByTime(300);
      pty.feed(SPLASH);
    }
  }

  /** Launch the first Claude (pid 200) and let the tracker pick it. */
  async function firstClaude(): Promise<void> {
    pty.feed(PROMPT);
    launch();
    processes = [SHELL, claudeProcess(200)];
    tracker.arm('pane-a', SHELL_PID);
    await vi.waitFor(() => expect(tracker.pidFor('pane-a')).toBe(200), { timeout: 5_000 });
  }

  async function firstClaudeThenExit(): Promise<void> {
    await firstClaude();
    bridge.noteInput('/exit\r');
    processes = [SHELL];
    pty.feed(SHELL_RETURN);
    vi.advanceTimersByTime(1000);
  }

  /** The monitor reports pid 200 dead while the relaunch (pid 201) runs, and the tracker settles. */
  async function predecessorDiesAfterRelaunch(): Promise<void> {
    processes = [SHELL, claudeProcess(201)];
    onDead.get(200)?.();
    await vi.waitFor(() => expect(tracker.pidFor('pane-a')).toBe(201), { timeout: 5_000 });
  }

  /** Esc during a turn, and the agent's own row confirming it. */
  function escAndRow(): void {
    vi.advanceTimersByTime(RESIZE_REDRAW_GUARD_MS);
    bridge.noteInput('reply hi\r');
    vi.advanceTimersByTime(1000);
    bridge.noteInput('\x1b');
    vi.advanceTimersByTime(250);
    pty.feed(ROW);
  }

  it.each([
    ['in separate reads', undefined],
    ['command start and splash in one read', COMMAND_START],
  ])('the late death edge of the previous Claude leaves the relaunch\'s gate open (%s)', async (_label, markers) => {
    await firstClaudeThenExit();
    launch(markers);
    expect(bridge.getLastAgent()).toBe('Claude Code');

    await predecessorDiesAfterRelaunch();
    expect(bridge.getLastAgent()).toBe('Claude Code');
    // The pane heard its new agent's launch, never a death.
    expect(edges.at(-1)).toMatchObject({ slug: 'claude', alive: true, replacedLive: true });
    expect(edges.filter((e) => !e.alive)).toEqual([]);

    escAndRow();
    expect(interrupted).toBe(1);
  });

  it('a read holding the old command end, the prompt, the command start and the splash leaves the gate open', async () => {
    await firstClaude();
    bridge.noteInput('/exit\r');
    processes = [SHELL];
    vi.advanceTimersByTime(1000);
    bridge.noteInput('claude\r');
    pty.feed(COMMAND_END + PROMPT + COMMAND_START + SPLASH);
    expect(bridge.getLastAgent()).toBe('Claude Code');
  });

  it('a relaunch known only by its own hook keeps that identity, and gets tracked', async () => {
    await firstClaudeThenExit();
    bridge.noteInput('claude --permission-mode default\r');
    pty.feed(COMMAND_START); // no splash the gate reads
    vi.advanceTimersByTime(300);
    expect(bridge.noteHookAgentIdentity(
      { kind: 'agent.session_start', agent: 'claude', ptyId: 'pane-a', cwd: '/repo', ts: Date.now(), payload: {} },
      { slug: 'claude', source: 'hook' },
    )).toBe(true);
    const detector = (bridge as unknown as { agentDetector: { getTrustedAgent(): string | null } }).agentDetector;

    await predecessorDiesAfterRelaunch();
    expect(detector.getTrustedAgent()).toBe('claude');
    expect(edges.filter((e) => !e.alive)).toEqual([]);
  });

  it('the previous Claude dying before the relaunch is reported, and the relaunch opens its own gate', async () => {
    await firstClaudeThenExit();
    expect(bridge.getLastAgent()).toBeNull(); // the shell return ended it
    onDead.get(200)?.();
    await vi.waitFor(() => expect(edges.at(-1)).toMatchObject({ slug: 'claude', alive: false }), { timeout: 5_000 });
    launch();
    expect(bridge.getLastAgent()).toBe('Claude Code');
    escAndRow();
    expect(interrupted).toBe(1);
  });

  it('the death of the Claude the pane still runs ends it', async () => {
    await firstClaude();
    expect(bridge.getLastAgent()).toBe('Claude Code');
    processes = [SHELL];
    onDead.get(200)?.(); // killed, with no shell return yet
    await vi.waitFor(() => expect(edges.at(-1)).toMatchObject({ slug: 'claude', alive: false }), { timeout: 5_000 });
    expect(bridge.getLastAgent()).toBeNull();
  });

  it('another Claude under the shell does not hide the death of the one the pane ran when no command started since', async () => {
    await firstClaude();
    processes = [SHELL, claudeProcess(201)]; // a second Claude, started in the background earlier
    onDead.get(200)?.();
    expect(edges.at(-1)).toMatchObject({ slug: 'claude', alive: false });
    expect(bridge.getLastAgent()).toBeNull();
  });

  it('a different agent in the relaunch does not hide the death of the Claude before it', async () => {
    await firstClaudeThenExit();
    bridge.noteInput('codex\r');
    pty.feed(COMMAND_START);
    processes = [SHELL, { pid: 301, ppid: SHELL_PID, name: 'codex' }];
    onDead.get(200)?.();
    await vi.waitFor(() => expect(edges.at(-1)).toMatchObject({ slug: 'claude', alive: false }), { timeout: 5_000 });
  });

  it('a real death still ends the agent after its own pane crossed a shell boundary and named it again', async () => {
    await firstClaude();
    // A subshell inside the session marks its own command start and end; the
    // screen names Claude Code again afterwards. The process is the same.
    pty.feed(COMMAND_START + COMMAND_END);
    pty.feed(SPLASH);
    expect(bridge.getLastAgent()).toBe('Claude Code');
    processes = [SHELL];
    onDead.get(200)?.();
    await vi.waitFor(() => expect(edges.at(-1)).toMatchObject({ slug: 'claude', alive: false }), { timeout: 5_000 });
    expect(bridge.getLastAgent()).toBeNull();
  });
});
