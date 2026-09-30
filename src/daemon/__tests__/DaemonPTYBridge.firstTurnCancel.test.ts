// #1670 — a lone Esc pressed before the first prompt (dismissing Codex's
// update notice) made the first turn uncancellable: the boot burst's byte
// promotion had opened the episode at pane creation, the submit joined it, and
// the cancel gate `escAt >= turn.startedAt` read the pre-prompt Esc as this
// turn's interrupt. Replays the daemon's wiring (every stdin write goes to
// `noteInput`) and runs the real gate against the bridge's own turn and Esc.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IPty } from 'node-pty';
import fs from 'node:fs';
import path from 'node:path';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { PromptEventLog } from '../PromptEventLog';
import { RingBuffer } from '../RingBuffer';
import { interruptChatTurn } from '../transcript/interruptChatTurn';

const BIG = 'x'.repeat(3000); // > ActivityMonitor's 2 KB active threshold
const BANNER = '\x1b[9;1H│ >_ OpenAI Codex (v0.149.1)            │\r\n';
const CODEX_MODES = '\x1b[?2004h\x1b[?1049h';
const LAUNCH_OUTPUT = '\x1b[?2004l\x1b]133;C\x07';
const screens = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'transcript', '__tests__', 'fixtures', 'running-turn-screens.json'), 'utf8')) as Record<string, { rows: string[] }>;

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

describe('DaemonPTYBridge — #1670 first turn starts at the submit', () => {
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
  const turnOpen = () => (bridge as unknown as { turnOpen: boolean }).turnOpen;

  /** The chat Stop gate, fed from this bridge the way the chat bridge feeds it. */
  const stop = (slug: 'codex' | 'claude') => interruptChatTurn('conversation-1', {
    getTranscriptSessionId: () => 'conversation-1',
    hasOpenApproval: () => false,
    readScreen: async () => screens[slug === 'codex' ? 'codex-working' : 'claude-tool'].rows,
    getAgentState: () => ({ slug, status: bridge.getAgentStatus(), turn: turn() }),
    write: (data) => { bridge.noteInput(data); return true; },
    lastEscAt: () => bridge.getLastEscAt(),
  });

  /** Esc before any prompt, then the first prompt and its first output. */
  async function escThenFirstPrompt(): Promise<number> {
    vi.advanceTimersByTime(1000);
    bridge.noteInput('\x1b'); // dismiss the update notice
    const escAt = Date.now();
    vi.advanceTimersByTime(1000);
    bridge.noteInput('write a long essay\r');
    const submittedAt = Date.now();
    vi.advanceTimersByTime(100);
    feed(BIG);
    expect(bridge.getLastEscAt()).toBe(escAt);
    expect(turn()).toMatchObject({ state: 'running', startedAt: submittedAt });
    vi.advanceTimersByTime(2000); // past the pane's Esc cooldown
    feed(BIG); // still working
    return submittedAt;
  }

  it('Codex spawned straight into the pane (phone launch): the pre-prompt Esc does not block the first cancel', async () => {
    feed(CODEX_MODES + BANNER + BIG); // boot burst: byte promotion opens an episode
    expect(turnOpen()).toBe(true);
    const boot = turn();
    await escThenFirstPrompt();
    expect(turn().id).not.toBe(boot.id);
    expect(await stop('codex')).toBe('sent');
  });

  it('Codex launched from a shell, with a repaint after the boot: same', async () => {
    bridge.noteInput('codex\r');
    feed(LAUNCH_OUTPUT);
    vi.advanceTimersByTime(300);
    feed(CODEX_MODES + BANNER + BIG); // the launch Enter owns this first burst
    vi.advanceTimersByTime(5000);
    feed(BIG); // the update notice paints: a byte promotion opens an episode
    expect(turnOpen()).toBe(true);
    await escThenFirstPrompt();
    expect(await stop('codex')).toBe('sent');
  });

  it('Claude with hooks (SessionStart at boot): same', async () => {
    bridge.noteInput('claude\r');
    feed(LAUNCH_OUTPUT);
    vi.advanceTimersByTime(300);
    bridge.noteSessionStart(Date.now(), 'startup');
    feed(BIG);
    vi.advanceTimersByTime(5000);
    feed(BIG); // a later boot repaint opens an episode
    expect(turnOpen()).toBe(true);
    await escThenFirstPrompt();
    bridge.noteAgentStatus('running', true); // UserPromptSubmit
    expect(await stop('claude')).toBe('sent');
  });

  it('an Esc during the turn still blocks a duplicate Stop', async () => {
    feed(CODEX_MODES + BANNER + BIG);
    await escThenFirstPrompt();
    bridge.noteInput('\x1b'); // the user's own Esc interrupts the running turn
    vi.advanceTimersByTime(2500); // past the cooldown
    feed(BIG);
    expect(await stop('codex')).toBe('already_interrupted');
  });

  it('a trust dialog answered with Enter before the first prompt: same', async () => {
    feed(CODEX_MODES + BANNER + BIG); // boot burst: byte promotion opens an episode
    const boot = turn();
    bridge.noteAgentStatus('awaiting_input'); // "Do you trust the contents of this directory?"
    vi.advanceTimersByTime(500);
    bridge.noteInput('\r'); // trust and continue
    expect(bridge.isAwaitingHuman()).toBe(false);
    feed(BIG);
    await escThenFirstPrompt();
    expect(turn().id).not.toBe(boot.id);
    expect(await stop('codex')).toBe('sent');
  });

  it('a trust dialog the detector does not see, answered with Enter: same', async () => {
    feed(CODEX_MODES + BANNER + BIG); // boot burst
    vi.advanceTimersByTime(1000);
    bridge.noteInput('\r'); // "Trust this folder?" -> Trust and continue: no turn starts
    const trusted = turn();
    vi.advanceTimersByTime(100);
    feed(BIG); // the composer paints
    await escThenFirstPrompt();
    expect(turn().id).not.toBe(trusted.id);
    expect(await stop('codex')).toBe('sent');
  });

  it('a first turn started from the command line keeps its id and its Esc through a queued prompt', async () => {
    const working = (frame: string) => feed(`\x1b]0;${frame} Working\x07` + BIG);
    // `codex "task"` with no hooks: the boot burst is the first turn, and it runs.
    working('⠋');
    feed(CODEX_MODES + BANNER);
    const first = turn();
    expect(first.state).toBe('running');
    vi.advanceTimersByTime(3000);
    working('⠙');
    bridge.noteInput('\x1b'); // the user interrupts it
    vi.advanceTimersByTime(2500);
    working('⠹'); // still winding down
    bridge.noteInput('then summarize\r'); // queued behind the running turn
    expect(turn()).toMatchObject({ id: first.id, startedAt: first.startedAt });
    working('⠸');
    expect(await stop('codex')).toBe('already_interrupted');
  });

  it('a prompt typed into a running turn after the first one stays in it', () => {
    feed(CODEX_MODES + BANNER + BIG);
    vi.advanceTimersByTime(1000);
    bridge.noteInput('first\r');
    vi.advanceTimersByTime(100);
    feed('\x1b]0;⠋ Working\x07' + BIG); // Codex's running spinner title
    const first = turn();
    bridge.noteInput('also this\r');
    expect(turn().id).toBe(first.id);
    // Once joined, the turn is confirmed: a later quiet stretch does not split it.
    vi.advanceTimersByTime(10_000);
    bridge.noteInput('and this\r');
    expect(turn().id).toBe(first.id);
  });
});
