// OSC 7501: Codex reports its own state (idle / working / blocked / clear).
// On a pane whose agent is known, those reports drive the turn; the title,
// byte and screen heuristics are the fallback.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { RingBuffer } from '../RingBuffer';
import { PromptEventLog } from '../PromptEventLog';
import { CODEX_0163_SESSION } from './fixtures/codexProgramStatus';

const BANNER = '\x1b[9;1H│ >_ OpenAI Codex (v0.163.0)            │\r\n';
const CODEX_MODES = '\x1b[?2004h\x1b[?1049h';
const report = (body: string) => `\x1b]7501;${body}\x1b\\`;
const title = (t: string) => `\x1b]0;${t}\x07`;

function makeFakePty(): { pty: IPty; feed: (data: string) => void; exit: () => void } {
  let dataHandler: ((data: string) => void) | null = null;
  let exitHandler: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  const pty = {
    onData: (cb: (data: string) => void) => {
      dataHandler = cb;
      return { dispose: () => { dataHandler = null; } };
    },
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
      exitHandler = cb;
      return { dispose: () => { exitHandler = null; } };
    },
  } as unknown as IPty;
  // The bridge analyses a chunk after forwarding it (M3 A1): one turn of
  // the (fake) event loop lets that analysis run, as it did inside the call.
  return { pty, feed: (data) => { dataHandler?.(data); vi.advanceTimersByTime(0); }, exit: () => exitHandler?.({ exitCode: 0 }) };
}

describe('DaemonPTYBridge — OSC 7501 program status', () => {
  let bridge: DaemonPTYBridge;
  let feed: (data: string) => void;
  let exit: () => void;
  let agentEvents: Array<{ status: string; agent: string; message: string }>;
  let idles: unknown[];
  let answered: Array<{ reason?: string }>;

  /** Replays the captured reports of `steps`, advancing the clock to each one's time. */
  let clock = 0;
  const replay = (...steps: string[]) => {
    for (const r of CODEX_0163_SESSION.filter((x) => steps.includes(x.step))) {
      if (r.at > clock) vi.advanceTimersByTime(r.at - clock);
      clock = Math.max(clock, r.at);
      feed(r.bytes);
    }
  };

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 0;
    bridge = new DaemonPTYBridge();
    const fake = makeFakePty();
    feed = fake.feed;
    exit = fake.exit;
    bridge.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-1', new PromptEventLog());
    bridge.noteAgentProcess({ slug: 'codex', alive: true });
    feed(CODEX_MODES + BANNER);
    agentEvents = [];
    idles = [];
    answered = [];
    bridge.on('agent', (e: { event: { status: string; agent: string; message: string } }) => agentEvents.push(e.event));
    bridge.on('idle', (e: unknown) => idles.push(e));
    bridge.on('answered', (e: { reason?: string }) => answered.push(e));
  });

  afterEach(() => {
    bridge.cleanup();
    vi.useRealTimers();
  });

  it('replays a Codex session: the boot settles, and a turn runs until Codex says idle, however quiet', () => {
    replay('boot');
    expect(bridge.isProgramStatusDriving()).toBe(true);
    expect(bridge.getAgentStatus()).toBe('waiting');
    expect(bridge.isTurnOpen()).toBe(false);

    bridge.noteInput('say hi\r');
    replay('turn 1');
    expect(bridge.getAgentStatus()).toBe('running');
    // Reasoning with nothing on screen: byte silence is not the turn's end.
    idles = [];
    vi.advanceTimersByTime(60_000);
    expect(bridge.getAgentStatus()).toBe('running');
    expect(bridge.isTurnOpen()).toBe(true);
    expect(idles).toEqual([]);

    replay('turn 1 ends');
    expect(bridge.getAgentStatus()).toBe('waiting');
    expect(bridge.isTurnOpen()).toBe(false);
    expect(agentEvents.at(-1)).toEqual({ agent: 'Codex CLI', status: 'waiting', message: 'Ready for input' });
  });

  it('blocked raises needs-you once; the decline and Codex\'s own reports settle it', () => {
    replay('boot');
    bridge.noteInput('touch probe.txt\r');
    replay('turn 2');
    agentEvents = [];
    replay('approval box');
    expect(bridge.getAgentStatus()).toBe('awaiting_input');
    // Codex's approval title arrives too; it is the same dialog, told once.
    feed(title('[ ! ] Action Required | work'));
    feed(title('[ . ] Action Required | work'));
    feed('\r\n  Would you like to run the following command?\r\n');
    expect(agentEvents).toEqual([{ agent: 'Codex CLI', status: 'awaiting_input', message: 'Waiting on you' }]);
    // Nor does the title dropping the box release it while Codex still says blocked.
    feed(title('work'));
    expect(bridge.getAgentStatus()).toBe('awaiting_input');

    bridge.noteInput('\x1b');
    replay('declined', 'turn 2 ends');
    expect(bridge.getAgentStatus()).toBe('waiting');
    expect(bridge.isTurnOpen()).toBe(false);

    // `/quit`: Codex clears its record and the heuristics take the pane back.
    replay('quit');
    expect(bridge.getProgramStatus()).toBeUndefined();
    expect(bridge.isProgramStatusDriving()).toBe(false);
  });

  it('a dialog answered with a key no rule reads (Codex `y`) is released by Codex reporting working', () => {
    replay('boot');
    bridge.noteInput('touch probe.txt\r');
    replay('turn 2', 'approval box');
    bridge.noteInput('y');
    expect(bridge.getAgentStatus()).toBe('awaiting_input');
    feed(report('state=working:app=codex'));
    expect(answered).toEqual([{ sessionId: 'sess-1', reason: 'screen-cleared' }]);
    expect(bridge.getAgentStatus()).toBe('running');
  });

  it('the screen heuristics cannot settle a turn Codex says is working, nor run one it settled', () => {
    replay('boot');
    bridge.noteInput('say hi\r');
    replay('turn 1');
    agentEvents = [];
    // The detector's Codex idle prompt mid-turn.
    feed('\r\ncodex>\r\n');
    expect(agentEvents).toEqual([]);
    expect(bridge.getAgentStatus()).toBe('running');

    replay('turn 1 ends');
    vi.advanceTimersByTime(10_000);
    // A burst on the settled pane (a repaint), well past every cooldown.
    feed('x'.repeat(8_000));
    vi.advanceTimersByTime(100);
    feed('y'.repeat(8_000));
    expect(bridge.getAgentStatus()).toBe('waiting');
    expect(bridge.isTurnOpen()).toBe(false);
  });

  it('a pane a provisional hook Stop settled while Codex still says working is promoted by its output', () => {
    replay('boot');
    bridge.noteInput('touch probe.txt\r');
    replay('turn 2');
    bridge.noteAgentStatus('complete', true, undefined, true);
    expect(bridge.getAgentStatus()).toBe('complete');
    vi.advanceTimersByTime(7_000);
    feed('x'.repeat(8_000));
    vi.advanceTimersByTime(100);
    feed('y'.repeat(8_000));
    expect(bridge.getAgentStatus()).toBe('running');
  });

  it('working and blocked end with the process, a new shell prompt or RIS; done survives the prompt', () => {
    replay('boot');
    feed(report('state=blocked:kind=permission:app=codex'));
    expect(bridge.getAgentStatus()).toBe('awaiting_input');
    expect(agentEvents.at(-1)?.message).toBe('Approval requested');
    exit();
    expect(bridge.getProgramStatus()).toBeUndefined();
    expect(bridge.isProgramStatusDriving()).toBe(false);
    expect(bridge.getAgentStatus()).not.toBe('awaiting_input');

    feed(report('state=working:app=codex'));
    expect(bridge.getProgramStatus()?.state).toBe('working');
    feed('\x1b]133;A\x07');
    expect(bridge.getProgramStatus()).toBeUndefined();

    feed(report('state=done:app=codex'));
    feed('\x1b]133;A\x07');
    expect(bridge.getProgramStatus()?.state).toBe('done');
    expect(bridge.isProgramStatusDriving()).toBe(false);

    feed(report('state=working:app=codex'));
    feed('\x1b'); // RIS split across two chunks
    feed('c');
    expect(bridge.getProgramStatus()).toBeUndefined();
  });

  it('after Codex exits, 7501 bytes another program prints do not speak for it', () => {
    replay('boot');
    feed(report('state=clear'));
    bridge.noteAgentProcess({ slug: 'codex', alive: false });
    // e.g. `cat` of a crafted file: the detector still names Codex, the process is gone.
    feed(report('state=blocked:kind=permission:app=codex'));
    expect(bridge.isProgramStatusDriving()).toBe(false);
    expect(bridge.getAgentStatus()).not.toBe('awaiting_input');
    feed(report('state=working:app=codex'));
    expect(bridge.getAgentStatus()).not.toBe('running');
  });

  it('a working pane with no output and no report for five minutes goes back to the heuristics', () => {
    replay('boot');
    bridge.noteInput('say hi\r');
    replay('turn 1');
    idles = [];
    vi.advanceTimersByTime(4 * 60_000);
    expect(bridge.getAgentStatus()).toBe('running');
    vi.advanceTimersByTime(2 * 60_000);
    expect(bridge.isProgramStatusDriving()).toBe(false);
    expect(idles).toHaveLength(1);
    // Codex speaks again: it drives again.
    feed(report('state=idle:app=codex'));
    expect(bridge.isProgramStatusDriving()).toBe(true);
    expect(bridge.getAgentStatus()).toBe('waiting');
  });

  it('a repeated working report refreshes activity at the spinner cadence', () => {
    replay('boot');
    bridge.noteInput('say hi\r');
    const actives: unknown[] = [];
    bridge.on('active', (e: unknown) => actives.push(e));
    replay('turn 1');
    // Output keeps the activity cycle open, so only a refresh reports `active` again.
    const paint = (ms: number) => { for (let t = 0; t < ms; t += 2_000) { feed('.'); vi.advanceTimersByTime(2_000); } };
    paint(4_000);
    const settled = actives.length;
    feed(report('state=working:app=codex'));
    expect(actives).toHaveLength(settled);
    paint(32_000);
    feed(report('state=working:app=codex'));
    expect(actives).toHaveLength(settled + 1);
  });

  it('a repeated idle right after a submit does not end the turn the submit started', () => {
    replay('boot');
    vi.advanceTimersByTime(500);
    bridge.noteInput('say hi\r');
    feed(report('state=idle:app=codex'));
    expect(bridge.isTurnOpen()).toBe(true);
    expect(bridge.getAgentStatus()).not.toBe('waiting');
    replay('turn 1');
    expect(bridge.getAgentStatus()).toBe('running');
  });

  it('the screen naming another agent ends the reporting one\'s episode', () => {
    replay('boot');
    expect(bridge.isProgramStatusDriving()).toBe(true);
    feed('\x1b[?1049l\r\nClaude Code v2.1.310\r\n  bypass permissions on\r\n');
    expect(bridge.isProgramStatusDriving()).toBe(false);
  });

  it('the quiet bound fires on an autonomous turn whose output stops, and ends the turn', () => {
    replay('boot');
    vi.advanceTimersByTime(10_000);
    // One report, then nothing at all: no output ever starts the activity
    // monitor's idle countdown, so only the report itself can arm the bound.
    feed(report('state=working:app=codex'));
    expect(bridge.getAgentStatus()).toBe('running');
    vi.advanceTimersByTime(6 * 60_000);
    expect(bridge.isProgramStatusDriving()).toBe(false);
    expect(bridge.isTurnOpen()).toBe(false);
    expect(bridge.isAgentMidTurn()).toBe(false);
    expect(bridge.getAgentStatus()).not.toBe('running');
  });

  it('a submit Codex never turns into work (an empty Enter) ends with the silence', () => {
    replay('boot');
    vi.advanceTimersByTime(10_000);
    bridge.noteInput('\r');
    feed('\x1b[20;1H\u203a '); // the composer repaints, nothing more
    expect(bridge.isTurnOpen()).toBe(true);
    vi.advanceTimersByTime(6_000);
    expect(bridge.isTurnOpen()).toBe(false);
    expect(bridge.isAgentMidTurn()).toBe(false);
    expect(bridge.getAgentStatus()).toBe('waiting');
  });

  it('a repeated idle well after a submit ends the turn the program never started', () => {
    replay('boot');
    vi.advanceTimersByTime(500);
    bridge.noteInput('/status\r');
    vi.advanceTimersByTime(2_500);
    feed(report('state=idle:app=codex'));
    expect(bridge.isTurnOpen()).toBe(false);
    expect(bridge.getAgentStatus()).toBe('waiting');
  });

  it('a repeated idle inside the submit grace still lets the silence end an unworked submit', () => {
    replay('boot');
    vi.advanceTimersByTime(10_000);
    bridge.noteInput('\r');
    feed('\x1b[20;1H\u203a ');
    vi.advanceTimersByTime(1_000);
    feed(report('state=idle:app=codex')); // skipped: it crosses the submit
    expect(bridge.isTurnOpen()).toBe(true);
    vi.advanceTimersByTime(6_000);
    expect(bridge.isTurnOpen()).toBe(false);
    expect(bridge.isAgentMidTurn()).toBe(false);
  });

  it('the first prompt after launch is a turn once Codex reports working', () => {
    replay('boot');
    vi.advanceTimersByTime(1_000);
    bridge.noteInput('say hi\r');
    expect(bridge.isAgentMidTurn()).toBe(false); // #1670: a boot episode until proven
    replay('turn 1');
    expect(bridge.isAgentMidTurn()).toBe(true);
  });

  it('a bare first Enter (a dialog answer) followed by Codex\'s startup working stays a boot episode', () => {
    replay('boot');
    vi.advanceTimersByTime(1_000);
    bridge.noteInput('\r');
    feed(report('state=working:app=codex'));
    expect(bridge.isAgentMidTurn()).toBe(false);
  });

  it('RIS after a report in the same chunk removes it; a report after RIS stands', () => {
    replay('boot');
    feed(report('state=working:app=codex') + '\x1bc');
    expect(bridge.getProgramStatus()).toBeUndefined();
    feed('\x1bc' + report('state=working:app=codex'));
    expect(bridge.getProgramStatus()?.state).toBe('working');
  });

  it('a report Codex wrote before the tracker saw it alive is applied when it does', () => {
    const late = new DaemonPTYBridge();
    const fake = makeFakePty();
    late.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-4', new PromptEventLog());
    fake.feed(CODEX_MODES + BANNER);
    fake.feed(report('state=idle:app=codex'));
    expect(late.isProgramStatusDriving()).toBe(false);
    late.noteAgentProcess({ slug: 'codex', alive: true });
    expect(late.isProgramStatusDriving()).toBe(true);
    expect(late.getAgentStatus()).toBe('waiting');
    late.cleanup();
  });

  it('a record left from an earlier episode is not applied when the next agent starts', () => {
    replay('boot');
    feed(report('state=done:app=codex'));
    bridge.noteAgentProcess({ slug: 'codex', alive: false });
    feed('\x1b]133;A\x07');
    expect(bridge.getProgramStatus()?.state).toBe('done');
    bridge.noteAgentProcess({ slug: 'codex', alive: true });
    expect(bridge.isProgramStatusDriving()).toBe(false);
  });

  it('error settles as a neutral turn end, never worded as an API failure', () => {
    replay('boot');
    bridge.noteInput('say hi\r');
    replay('turn 1');
    feed(report('state=error:app=codex'));
    expect(bridge.getAgentStatus()).toBe('complete');
    expect(agentEvents.at(-1)).toEqual({ agent: 'Codex CLI', status: 'complete', message: 'Turn ended' });
  });

  it('stores, but does not act on, a report from a pane with no known agent', () => {
    const plain = new DaemonPTYBridge();
    const fake = makeFakePty();
    plain.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-2', new PromptEventLog());
    fake.feed(report('state=working:app=brew'));
    expect(plain.getProgramStatus()).toEqual(expect.objectContaining({ state: 'working', app: 'brew' }));
    expect(plain.isProgramStatusDriving()).toBe(false);
    expect(plain.isTurnOpen()).toBe(false);
    plain.cleanup();
  });

  it('never reads a report out of recovered history, only live output', () => {
    const ring = new RingBuffer(65536);
    ring.write(Buffer.from(CODEX_MODES + BANNER + report('state=blocked:app=codex')));
    const recovered = new DaemonPTYBridge();
    const fake = makeFakePty();
    recovered.setupDataForwarding(fake.pty, ring, 'sess-3', new PromptEventLog());
    recovered.noteAgentProcess({ slug: 'codex', alive: true });
    expect(recovered.getProgramStatus()).toBeUndefined();
    expect(recovered.getAgentStatus()).not.toBe('awaiting_input');
    fake.feed(report('state=working:app=codex'));
    expect(recovered.getProgramStatus()?.state).toBe('working');
    recovered.cleanup();
  });
});
