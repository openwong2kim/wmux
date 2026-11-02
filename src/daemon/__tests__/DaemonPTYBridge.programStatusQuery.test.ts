// OSC 7501 feature query: Claude Code (and Grok Build) ask `OSC 7501 ; ?` and
// report nothing until the terminal answers. Answered, Claude Code drops the
// spinner and idle glyphs from its window title, so its reports must drive
// the pane wherever the title did; unanswered, the title still does.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { DaemonPTYBridge, PROGRAM_STATUS_PROBE_REPLY } from '../DaemonPTYBridge';
import { RingBuffer } from '../RingBuffer';
import { PromptEventLog } from '../PromptEventLog';
import { titleShowsFinishedTurn, titleShowsRunningTurn } from '../transcript/chatScreenGate';
import { CLAUDE_2_1_312_SESSION } from './fixtures/claudeProgramStatus';

const QUERY_BEL = '\x1b]7501;?\x07';
const QUERY_ST = '\x1b]7501;?\x1b\\';
const CLAUDE_BANNER = 'Claude Code v2.1.312\r\n  bypass permissions on\r\n';

function makeFakePty(write?: (data: string) => void): { pty: IPty; feed: (data: string) => void; writes: string[] } {
  let dataHandler: ((data: string) => void) | null = null;
  const writes: string[] = [];
  const pty = {
    onData: (cb: (data: string) => void) => {
      dataHandler = cb;
      return { dispose: () => { dataHandler = null; } };
    },
    onExit: () => ({ dispose: () => undefined }),
    write: (data: string) => {
      write?.(data);
      writes.push(data);
    },
  } as unknown as IPty;
  return { pty, feed: (data) => dataHandler?.(data), writes };
}

describe('DaemonPTYBridge — OSC 7501 feature query', () => {
  let bridge: DaemonPTYBridge;

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = new DaemonPTYBridge();
  });

  afterEach(() => {
    bridge.cleanup();
    vi.useRealTimers();
  });

  it('answers every query with `ESC ] 7501 ; ? ESC \\` straight to the PTY while a live tracked agent owns the pane', () => {
    const fake = makeFakePty();
    bridge.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-1', new PromptEventLog());
    bridge.noteAgentProcess({ slug: 'claude', alive: true });
    expect(Buffer.from(PROGRAM_STATUS_PROBE_REPLY).toString('hex')).toBe('1b5d373530313b3f1b5c');
    fake.feed(`\x1b[?u${QUERY_BEL}\x1b[c`);
    expect(fake.writes).toEqual([PROGRAM_STATUS_PROBE_REPLY]);
    // Asked again later (either terminator): answered again. Not user input.
    vi.advanceTimersByTime(5_000);
    fake.feed(QUERY_ST);
    expect(fake.writes).toEqual([PROGRAM_STATUS_PROBE_REPLY, PROGRAM_STATUS_PROBE_REPLY]);
    expect(bridge.getInputRevision()).toBe(0);
  });

  it('does not answer with no live tracked agent: its reports would not be applied, so Claude keeps its title glyphs', () => {
    const fake = makeFakePty();
    bridge.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-1', new PromptEventLog());
    fake.feed(CLAUDE_BANNER + QUERY_BEL);
    bridge.noteAgentProcess({ slug: 'claude', alive: true });
    bridge.noteAgentProcess({ slug: 'claude', alive: false });
    fake.feed(QUERY_BEL);
    expect(fake.writes).toEqual([]);
  });

  it('never answers a query in recovered history, only the live one', () => {
    const ring = new RingBuffer(65536);
    ring.write(Buffer.from(`${CLAUDE_BANNER}${QUERY_BEL}\x1b[c`));
    const fake = makeFakePty();
    bridge.setupDataForwarding(fake.pty, ring, 'sess-1', new PromptEventLog());
    bridge.noteAgentProcess({ slug: 'claude', alive: true });
    expect(fake.writes).toEqual([]);
    fake.feed(QUERY_BEL);
    expect(fake.writes).toEqual([PROGRAM_STATUS_PROBE_REPLY]);
  });

  it('never answers a query held while muted, released late with the held output', () => {
    const fake = makeFakePty();
    bridge.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-1', new PromptEventLog());
    bridge.noteAgentProcess({ slug: 'claude', alive: true });
    bridge.setMuted(true);
    fake.feed(`${QUERY_BEL}\x1b[c`);
    vi.advanceTimersByTime(3_000);
    bridge.setMuted(false, { replayHeld: true });
    expect(fake.writes).toEqual([]);
  });

  it('the reply reaches the PTY before the chunk carrying the query (and the DA1 behind it) goes to any viewer', () => {
    const fake = makeFakePty();
    bridge.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-1', new PromptEventLog());
    bridge.noteAgentProcess({ slug: 'claude', alive: true });
    const writesAtEmit: number[] = [];
    bridge.on('data', () => writesAtEmit.push(fake.writes.length));
    fake.feed(`${QUERY_BEL}\x1b[c`);
    expect(writesAtEmit).toEqual([1]);
  });

  it('does not answer a command the shell started behind the agent (Ctrl+Z, then a command)', () => {
    const fake = makeFakePty();
    bridge.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-1', new PromptEventLog());
    fake.feed('\x1b]133;C\x07'); // the shell runs `claude`
    bridge.noteAgentProcess({ slug: 'claude', alive: true });
    fake.feed(QUERY_BEL);
    expect(fake.writes).toEqual([PROGRAM_STATUS_PROBE_REPLY]);
    // Suspended: the shell prompts and runs `cat` of a file holding the query.
    fake.feed('\x1b]133;D;148\x07\x1b]133;A\x07\x1b]133;B\x07');
    fake.feed('\x1b]133;C\x07');
    bridge.noteAgentProcess({ slug: 'claude', alive: true });
    fake.feed(QUERY_BEL);
    expect(fake.writes).toEqual([PROGRAM_STATUS_PROBE_REPLY]);
  });

  it('WMUX_PROGRAM_STATUS_REPLY=0 turns the reply off', () => {
    vi.stubEnv('WMUX_PROGRAM_STATUS_REPLY', '0');
    try {
      const fake = makeFakePty();
      bridge.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-1', new PromptEventLog());
      bridge.noteAgentProcess({ slug: 'claude', alive: true });
      fake.feed(QUERY_BEL);
      expect(fake.writes).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a PTY that refuses the write does not break output handling', () => {
    const fake = makeFakePty(() => { throw new Error('EPIPE'); });
    bridge.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-1', new PromptEventLog());
    bridge.noteAgentProcess({ slug: 'claude', alive: true });
    expect(() => fake.feed(`${QUERY_BEL}\x1b]7501;state=idle:app=claude-code\x07`)).not.toThrow();
    expect(bridge.getProgramStatus()?.state).toBe('idle');
  });
});

describe('DaemonPTYBridge — Claude Code with its query answered', () => {
  let bridge: DaemonPTYBridge;
  let fake: ReturnType<typeof makeFakePty>;
  let agentEvents: Array<{ status: string; agent: string; message: string }>;
  let interrupted: unknown[];
  let edges: Array<number | null>;
  let clock = 0;
  const replay = (...steps: string[]) => {
    for (const r of CLAUDE_2_1_312_SESSION.filter((x) => steps.includes(x.step))) {
      if (r.at > clock) vi.advanceTimersByTime(r.at - clock);
      clock = Math.max(clock, r.at);
      fake.feed(r.bytes);
    }
  };
  const at = (ms: number) => {
    vi.advanceTimersByTime(ms - clock);
    clock = ms;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 0;
    bridge = new DaemonPTYBridge();
    fake = makeFakePty();
    bridge.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-1', new PromptEventLog());
    bridge.noteAgentProcess({ slug: 'claude', alive: true });
    agentEvents = [];
    interrupted = [];
    edges = [];
    bridge.on('agent', (e: { event: { status: string; agent: string; message: string } }) => agentEvents.push(e.event));
    bridge.on('turnInterrupted', (e: unknown) => interrupted.push(e));
    bridge.on('agentTurn', (p: { runningSince: number | null }) => edges.push(p.runningSince));
  });

  afterEach(() => {
    bridge.cleanup();
    vi.useRealTimers();
  });

  it('replays a session: the query is answered, and Claude\'s own reports run, block and settle its turns', () => {
    replay('boot', 'query');
    expect(fake.writes).toEqual([PROGRAM_STATUS_PROBE_REPLY]);
    replay('boot');
    expect(bridge.isProgramStatusDriving()).toBe(true);
    expect(bridge.getAgentStatus()).toBe('waiting');
    expect(bridge.isAgentMidTurn()).toBe(false);

    at(8495);
    const turn1Start = Date.now();
    bridge.noteInput('say hi\r');
    replay('turn 1');
    expect(bridge.getAgentStatus()).toBe('running');
    expect(bridge.isAgentMidTurn()).toBe(true);
    // A glyphless title is not the turn's end, and neither is byte silence.
    vi.advanceTimersByTime(60_000);
    expect(bridge.getAgentStatus()).toBe('running');
    // The chat gates (Stop, rewind, stall watch) read the running turn off the report.
    expect(titleShowsRunningTurn(bridge.getTitle(), 'claude', Date.now())).toBe(true);
    expect(titleShowsFinishedTurn(bridge.getTitle(), 'claude', turn1Start)).toBe(false);

    replay('turn 1 ends');
    expect(bridge.getAgentStatus()).toBe('complete');
    expect(bridge.isAgentMidTurn()).toBe(false);
    expect(agentEvents.at(-1)).toEqual({ agent: 'Claude Code', status: 'complete', message: 'Task complete' });
    expect(titleShowsRunningTurn(bridge.getTitle(), 'claude', Date.now())).toBe(false);
    expect(titleShowsFinishedTurn(bridge.getTitle(), 'claude', turn1Start)).toBe(true);
    // A turn that finished on its own is not an interrupt.
    expect(interrupted).toEqual([]);

    at(12420);
    bridge.noteInput('touch probe.txt\r');
    replay('turn 2');
    expect(bridge.getAgentStatus()).toBe('running');
    agentEvents = [];
    replay('approval box');
    expect(bridge.getAgentStatus()).toBe('awaiting_input');
    expect(agentEvents).toEqual([{ agent: 'Claude Code', status: 'awaiting_input', message: 'Approval requested' }]);

    // Declined with Esc: Claude says `idle`, which confirms the Esc as an interrupt (#2264).
    at(15128);
    bridge.noteInput('\x1b');
    replay('declined');
    expect(bridge.getAgentStatus()).toBe('waiting');
    expect(bridge.isAgentMidTurn()).toBe(false);
    expect(interrupted).toEqual([{ sessionId: 'sess-1', agent: 'Claude Code' }]);

    at(17236);
    bridge.noteInput('/exit\r');
    replay('exit');
    expect(bridge.getProgramStatus()).toBeUndefined();
    expect(bridge.isProgramStatusDriving()).toBe(false);
    // Turn 1 and turn 2 each opened and closed once.
    expect(edges.filter((e) => e !== null)).toHaveLength(3);
    expect(edges.slice(0, 4).map((e) => e === null)).toEqual([false, true, false, true]);
  });

  it('a repeated settle report after a submit does not read as that turn finished', () => {
    replay('boot', 'query');
    replay('boot');
    vi.advanceTimersByTime(5_000);
    const startedAt = Date.now();
    bridge.noteInput('say hi\r');
    vi.advanceTimersByTime(100);
    fake.feed('\x1b]7501;state=idle:app=claude-code\x07');
    expect(titleShowsFinishedTurn(bridge.getTitle(), 'claude', startedAt)).toBe(false);
  });

  it('Claude\'s own idle after an Esc confirms the interrupt even right after a resize', () => {
    replay('boot', 'query');
    replay('boot');
    bridge.noteInput('think hard\r');
    fake.feed('\x1b]7501;state=working:app=claude-code\x07');
    vi.advanceTimersByTime(5_000);
    bridge.noteResize();
    bridge.noteInput('\x1b');
    vi.advanceTimersByTime(100);
    fake.feed('\x1b]7501;state=idle:app=claude-code\x07');
    expect(interrupted).toEqual([{ sessionId: 'sess-1', agent: 'Claude Code' }]);
  });

  it('a prompt typed into the turn a command-line prompt started joins it, as under the running title', () => {
    // `claude "<prompt>"`: the first turn starts with no prompt typed into Claude.
    replay('boot', 'query');
    replay('boot');
    fake.feed('\x1b]7501;state=working:app=claude-code\x07');
    expect(bridge.isTurnOpen()).toBe(true);
    const turn = bridge.getTurn(bridge.getAgentStatus()).id;
    vi.advanceTimersByTime(2_000);
    bridge.noteInput('and then the tests\r');
    expect(bridge.isAgentMidTurn()).toBe(true);
    expect(bridge.getTurn(bridge.getAgentStatus()).id).toBe(turn);
  });
});

describe('DaemonPTYBridge — Claude Code with its query unanswered', () => {
  it('keeps its title glyphs, and the title still confirms an Esc interrupt', () => {
    vi.useFakeTimers();
    const bridge = new DaemonPTYBridge();
    const fake = makeFakePty();
    const interrupted: unknown[] = [];
    bridge.on('turnInterrupted', (e: unknown) => interrupted.push(e));
    bridge.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-1', new PromptEventLog());
    vi.advanceTimersByTime(1_000);
    // The tracker has not seen Claude yet when it asks.
    fake.feed(`${CLAUDE_BANNER}\x1b]0;✳ Claude Code\x07${QUERY_BEL}\x1b[c`);
    expect(fake.writes).toEqual([]);
    bridge.noteAgentProcess({ slug: 'claude', alive: true });
    bridge.noteInput('think hard\r');
    fake.feed('\x1b]0;◐ Claude Code\x07');
    expect(titleShowsRunningTurn(bridge.getTitle(), 'claude', Date.now())).toBe(true);
    bridge.noteInput('\x1b');
    vi.advanceTimersByTime(84);
    fake.feed('\x1b]0;✳ Claude Code\x07');
    expect(interrupted).toEqual([{ sessionId: 'sess-1', agent: 'Claude Code' }]);
    expect(bridge.isProgramStatusDriving()).toBe(false);
    bridge.cleanup();
    vi.useRealTimers();
  });
});
