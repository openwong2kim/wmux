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
    DaemonPTYBridge.transcriptTurnEndProbe = null;
    vi.useRealTimers();
  });

  const turn = () => bridge.getTurn(bridge.getAgentStatus());

  it('keeps the latest window title and when it was written, repeats included', () => {
    expect(bridge.getTitle()).toEqual({ title: '', at: 0 });
    feed('\x1b]0;◐ Sleep command test\x07');
    expect(bridge.getTitle()).toEqual({ title: '◐ Sleep command test', at: Date.now() });
    vi.advanceTimersByTime(900);
    feed('out\x1b]2;◐ Sleep command test\x07more');
    expect(bridge.getTitle().at).toBe(Date.now());
    feed('\x1b]0;✳ Sleep command test\x07');
    expect(bridge.getTitle().title).toBe('✳ Sleep command test');
  });

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

  it('a prompt typed into a long quiet turn (no bytes, no settle) stays in it', () => {
    bridge.noteInput('run the migration\r');
    bridge.noteAgentStatus('running', true);
    const first = turn().id;
    vi.advanceTimersByTime(100);
    feed(BIG);
    vi.advanceTimersByTime(30_000); // a long tool call: byte activity went idle
    expect(bridge.getAgentStatus()).not.toBe('running');
    bridge.noteInput('then summarize\r');
    expect(turn().id).toBe(first);
  });

  it('a detector settle ends the episode only on a pane with no hook reports', () => {
    bridge.noteInput('go\r');
    bridge.noteAgentStatus('running', true); // this pane has hooks
    const first = turn();
    bridge.noteAgentStatus('complete'); // the idle footer matched mid-turn
    bridge.noteAgentStatus('running', true);
    bridge.noteInput('more\r');
    expect(turn().id).toBe(first.id);

    const hookless = new DaemonPTYBridge();
    const fake = makeFakePty();
    hookless.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-2', new PromptEventLog());
    hookless.noteInput('go\r');
    const a = hookless.getTurn('running').id;
    hookless.noteAgentStatus('complete');
    expect(hookless.getTurn('running').state).toBe('idle');
    hookless.noteInput('next\r');
    expect(hookless.getTurn('running').id).not.toBe(a);
    hookless.cleanup();
  });

  it('an end recorded before a byte-promoted episode does not close it', () => {
    bridge.noteInput('go\r');
    bridge.noteAgentStatus('complete', true);
    const endedAt = Date.now();
    vi.advanceTimersByTime(6100);
    feed(BIG); // autonomous turn, promoted from bytes alone
    const promoted = turn();
    expect(promoted.state).toBe('running');
    bridge.noteTranscriptTurnEnd(endedAt);
    expect(turn()).toEqual(promoted);
    expect(bridge.getTurnEvidenceStartedAt()).toBe(promoted.startedAt);
  });

  it('a submit consults the transcript, so an interrupt nobody polled still ends the episode', () => {
    const endAt: { v?: number } = {};
    DaemonPTYBridge.transcriptTurnEndProbe = (id) => (id === 'sess-1' ? endAt.v : undefined);
    bridge.noteInput('long task\r');
    bridge.noteAgentStatus('running', true);
    const first = turn().id;
    bridge.noteInput('queued\r'); // no end recorded: mid-turn
    expect(turn().id).toBe(first);
    vi.advanceTimersByTime(500);
    bridge.noteInput('\x1b');
    endAt.v = Date.now(); // `[Request interrupted by user]`
    vi.advanceTimersByTime(500);
    bridge.noteInput('try again\r');
    expect(turn().id).not.toBe(first);
  });

  it('a SessionStart never opens or ends an episode (Codex fires it inside its first turn)', () => {
    bridge.noteInput('go\r');
    const first = turn();
    bridge.noteSessionStart(Date.now(), 'compact');
    bridge.noteSessionStart(Date.now() - 10_000, 'startup'); // late duplicate
    vi.advanceTimersByTime(100);
    bridge.noteSessionStart(Date.now(), 'startup'); // fresh, after the submit
    expect(turn()).toEqual(first);
    bridge.noteAgentStatus('complete', true);
    vi.advanceTimersByTime(100);
    bridge.noteSessionStart(Date.now(), 'clear');
    expect(turn()).toEqual({ ...first, state: 'idle' });
  });

  it('Claude /exit then Codex: the first Codex prompt gets a new id that holds for the whole turn', () => {
    const osc133 = (c: string) => feed(`\x1b]133;${c}\x07`);
    // Claude, launched from the shell, with hooks.
    bridge.noteInput('claude\r');
    osc133('C');
    bridge.noteSessionStart(Date.now(), 'startup');
    vi.advanceTimersByTime(100);
    bridge.noteInput('fix it\r');
    bridge.noteAgentStatus('running', true);
    bridge.noteAgentStatus('complete', true);
    const claudeTurn = turn().id;

    // `/exit` is typed like a prompt and opens an episode no Stop will close.
    vi.advanceTimersByTime(100);
    bridge.noteInput('/exit\r');
    const exitEpisode = turn().id;
    expect(exitEpisode).not.toBe(claudeTurn);
    osc133('D;0'); // the shell has the foreground back
    osc133('A');
    osc133('B');
    expect(turn().state).toBe('idle');

    // Codex launch, then its first prompt.
    vi.advanceTimersByTime(100);
    bridge.noteInput('codex\r');
    osc133('C');
    vi.advanceTimersByTime(2000);
    bridge.noteInput('explain the tests\r');
    const codexTurn = turn();
    expect(codexTurn.id).not.toBe(exitEpisode);
    expect(codexTurn.state).toBe('running');

    // Codex's lazy SessionStart, its hooks, and a detector settle mid-turn.
    bridge.noteSessionStart(Date.now(), 'startup');
    bridge.noteAgentStatus('running', true);
    vi.advanceTimersByTime(100);
    feed(BIG);
    bridge.noteAgentStatus('complete'); // held detector stop confirmed by the alarm
    bridge.noteAgentStatus('running', true);
    vi.advanceTimersByTime(30_000);
    expect(turn().id).toBe(codexTurn.id);
    bridge.noteAgentStatus('complete', true); // the real Stop
    expect(turn()).toEqual({ ...codexTurn, state: 'idle' });
  });

  it('Claude /exit then a hookless Codex first turn: a mid-turn detector complete does not split the id', () => {
    const osc133 = (c: string) => feed(`\x1b]133;${c}\x07`);
    bridge.noteInput('claude\r');
    osc133('C');
    bridge.noteSessionStart(Date.now(), 'startup');
    vi.advanceTimersByTime(100);
    bridge.noteInput('fix it\r');
    bridge.noteAgentStatus('running', true);
    bridge.noteAgentStatus('complete', true);
    vi.advanceTimersByTime(100);
    bridge.noteInput('/exit\r');
    osc133('D;0');
    osc133('A');
    osc133('B');
    vi.advanceTimersByTime(100);
    bridge.noteInput('codex\r');
    osc133('C');
    vi.advanceTimersByTime(17_000);

    // Codex's first prompt; none of its hooks arrive until the turn is over.
    bridge.noteInput('explain the tests\r');
    const codexTurn = turn();
    expect(codexTurn.state).toBe('running');
    vi.advanceTimersByTime(100);
    feed(BIG);
    vi.advanceTimersByTime(10_000);
    bridge.noteAgentStatus('complete'); // detector read a pause between tools
    expect(turn().id).toBe(codexTurn.id);
    vi.advanceTimersByTime(6_000);
    feed(BIG); // work resumes: byte promotion
    expect(turn()).toEqual({ ...codexTurn, state: 'running' });
    vi.advanceTimersByTime(200);
    bridge.noteTranscriptTurnEnd(Date.now()); // rollout task_complete
    expect(turn()).toEqual({ ...codexTurn, state: 'idle' });
    // A burst after the recorded end is not the same turn resuming.
    vi.advanceTimersByTime(7_000);
    bridge.noteInput('next\r');
    expect(turn().id).not.toBe(codexTurn.id);
  });

  it('an unconfirmed (provisional) hook stop mid-turn does not split the id; the rollout end does end it', () => {
    const osc133 = (c: string) => feed(`\x1b]133;${c}\x07`);
    bridge.noteInput('codex\r');
    osc133('C');
    vi.advanceTimersByTime(17_000);
    bridge.noteInput('explain the tests\r'); // no rollout binding yet
    const codexTurn = turn();
    vi.advanceTimersByTime(100);
    feed(BIG);
    vi.advanceTimersByTime(8_000);
    // The notify chain fires a stop between tool calls; nothing confirms it.
    bridge.noteAgentStatus('complete', true, undefined, true);
    expect(turn()).toEqual({ ...codexTurn, state: 'idle' });
    vi.advanceTimersByTime(6_100);
    feed(BIG); // the turn goes on: byte promotion
    expect(turn()).toEqual({ ...codexTurn, state: 'running' });
    vi.advanceTimersByTime(3_000);
    bridge.noteTranscriptTurnEnd(Date.now()); // task_complete
    expect(turn()).toEqual({ ...codexTurn, state: 'idle' });
    vi.advanceTimersByTime(5_000);
    bridge.noteAgentStatus('complete', true, undefined, true); // the late duplicate stop
    expect(turn()).toEqual({ ...codexTurn, state: 'idle' });
    vi.advanceTimersByTime(1_000);
    bridge.noteInput('next\r');
    expect(turn().id).not.toBe(codexTurn.id);
  });

  it('an agent that ends without a Stop (process exit) closes its episode', () => {
    bridge.noteInput('go\r');
    bridge.noteAgentStatus('running', true);
    const first = turn().id;
    bridge.noteAgentEnded();
    expect(turn().state).toBe('idle');
    bridge.noteInput('next\r');
    expect(turn().id).not.toBe(first);
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
    const t2 = Date.now();
    expect(bridge.getLastEscAt()).toBe(t2);

    vi.advanceTimersByTime(1000);
    bridge.noteInput('\x1b[200~'); // an ESC inside a paste is text
    bridge.noteInput('\x1b');
    bridge.noteInput('\x1b[201~');
    expect(bridge.getLastEscAt()).toBe(t2);
  });
});
