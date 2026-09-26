// The awaiting-state screen verifier: a pane stuck at awaiting_input is
// released once its dialog is gone from the screen on two reads in a row, and
// never otherwise.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IPty } from 'node-pty';
import {
  AWAITING_VERIFY_RENDER_RETRIES,
  AwaitingScreenVerifier,
  renderPaneScreen,
  type AwaitingFrame,
  type AwaitingScreenVerifierDeps,
  type RenderablePane,
} from '../AwaitingScreenVerifier';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { RingBuffer } from '../RingBuffer';
import { generateTextSnapshot } from '../HeadlessSnapshot';
import { screenShowsAgentDialog } from '../transcript/chatScreenGate';

// ── Replay fixtures ──────────────────────────────────────────────────────────
// Built from the text of a real Claude Code permission dialog raised by a user
// `permissions.ask` rule in a bypassPermissions session, and the frame the pane
// drew once the dialog was answered. Paths and names are placeholders.

const DIALOG_FRAME = [
  // Mouse reporting was on in the pane the dialog was observed in.
  '\x1b[?1003h\x1b[?1006h',
  '\x1b[H\x1b[2J',
  '● Bash(rm -rf build/cache)\r\n',
  '\r\n',
  ' Bash command\r\n',
  '\r\n',
  '   rm -rf build/cache\r\n',
  '   Remove the build cache\r\n',
  '\r\n',
  ' Permission rule Bash(rm -rf *) requires confirmation for this command.\r\n',
  '\r\n',
  ' Do you want to proceed?\r\n',
  ' ❯ 1. Yes\r\n',
  '   2. No\r\n',
  '\r\n',
  ' Esc to cancel · Tab to amend',
].join('');

const RUNNING_FRAME = [
  '\x1b[H\x1b[2J',
  '● Bash(rm -rf build/cache)\r\n',
  '  ⎿  (No content)\r\n',
  '\r\n',
  '✻ Working… (3s · esc to interrupt)\r\n',
  '\r\n',
  '> \r\n',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('');

async function renderBytes(bytes: string): Promise<string[]> {
  const outcome = await generateTextSnapshot({ cols: 100, rows: 30, scrollback: 0, initial: Buffer.from(bytes) });
  if (!outcome.ok) throw new Error('snapshot failed');
  return outcome.rows.map((r) => r.text);
}

describe('screenShowsAgentDialog on replayed frames', () => {
  it('sees the permission dialog', async () => {
    expect(screenShowsAgentDialog(await renderBytes(DIALOG_FRAME))).toBe(true);
  });

  it('sees no dialog on the frame drawn after the answer', async () => {
    const rows = await renderBytes(DIALOG_FRAME + RUNNING_FRAME);
    expect(rows.some((r) => r.trim())).toBe(true);
    expect(screenShowsAgentDialog(rows)).toBe(false);
  });

  it.each([
    ['the question alone', ['', ' Do you want to proceed?']],
    ['a cursor option row alone', [' ❯ 2. No']],
    ['the footer alone', [' Esc to cancel · Tab to amend']],
  ])('any one dialog row is enough: %s', (_label, rows) => {
    expect(screenShowsAgentDialog(rows)).toBe(true);
  });
});

// ── Verifier state machine (fake render) ─────────────────────────────────────

const DIALOG_ROWS = [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel · Tab to amend'];
const CLEAR_ROWS = ['● Bash(rm -rf build/cache)', '  ⎿  (No content)', '✻ Working… (esc to interrupt)'];

interface FakePane {
  awaiting: boolean;
  eligible: boolean;
  mark: number;
  rows: readonly string[] | null;
}

function makeVerifier(pane: FakePane, overrides: Partial<AwaitingScreenVerifierDeps> = {}) {
  const renders: string[] = [];
  const cleared: string[] = [];
  const deps: AwaitingScreenVerifierDeps = {
    isAwaiting: () => pane.awaiting,
    eligible: () => pane.eligible,
    outputMark: () => pane.mark,
    render: async (id) => {
      renders.push(id);
      return pane.rows === null ? null : { rows: pane.rows, mark: pane.mark };
    },
    clear: (id) => {
      cleared.push(id);
      pane.awaiting = false;
    },
    ...overrides,
  };
  return { verifier: new AwaitingScreenVerifier(deps), renders, cleared };
}

/** New output on the pane, then the trigger the daemon fires for it. */
function output(v: AwaitingScreenVerifier, pane: FakePane, rows?: readonly string[] | null): void {
  pane.mark += 10;
  if (rows !== undefined) pane.rows = rows;
  v.trigger('p1', 'output');
}

describe('AwaitingScreenVerifier', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps the pane awaiting while the dialog stays on screen', async () => {
    const pane: FakePane = { awaiting: true, eligible: true, mark: 0, rows: DIALOG_ROWS };
    const { verifier, renders, cleared } = makeVerifier(pane);
    for (let i = 0; i < 20; i++) {
      output(verifier, pane);
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(renders.length).toBeGreaterThan(0);
    expect(cleared).toEqual([]);
  });

  it.each([
    ['unreadable', null],
    ['blank', ['', '   ', '']],
  ])('keeps the pane awaiting on a %s screen', async (_label, rows) => {
    const pane: FakePane = { awaiting: true, eligible: true, mark: 0, rows };
    const { verifier, cleared } = makeVerifier(pane);
    for (let i = 0; i < 10; i++) {
      output(verifier, pane);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(cleared).toEqual([]);
  });

  it('a single dialog-free read is not enough: the dialog coming back keeps awaiting', async () => {
    const pane: FakePane = { awaiting: true, eligible: true, mark: 0, rows: CLEAR_ROWS };
    const { verifier, renders, cleared } = makeVerifier(pane);
    output(verifier, pane);
    await vi.advanceTimersByTimeAsync(0);
    expect(renders).toHaveLength(1);
    // The dialog is redrawn before the settle confirmation reads again.
    pane.rows = DIALOG_ROWS;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(renders).toHaveLength(2);
    expect(cleared).toEqual([]);
  });

  it('two dialog-free reads in a row release the pane', async () => {
    const pane: FakePane = { awaiting: true, eligible: true, mark: 0, rows: DIALOG_ROWS };
    const { verifier, cleared } = makeVerifier(pane);
    output(verifier, pane);
    await vi.advanceTimersByTimeAsync(0);
    output(verifier, pane, CLEAR_ROWS);
    await vi.advanceTimersByTimeAsync(300);
    expect(cleared).toEqual([]);
    // No further output: the settle confirmation re-reads the same frame.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cleared).toEqual(['p1']);
    expect(verifier.trackedCount()).toBe(0);
  });

  it('never renders a pane whose agent is not Claude-family', async () => {
    const pane: FakePane = { awaiting: true, eligible: false, mark: 0, rows: CLEAR_ROWS };
    const { verifier, renders, cleared } = makeVerifier(pane);
    for (let i = 0; i < 5; i++) {
      output(verifier, pane);
      verifier.trigger('p1', 'input');
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(renders).toEqual([]);
    expect(cleared).toEqual([]);
    expect(verifier.trackedCount()).toBe(0);
  });

  it('never renders a pane that is not awaiting', async () => {
    const pane: FakePane = { awaiting: false, eligible: true, mark: 0, rows: CLEAR_ROWS };
    const { verifier, renders } = makeVerifier(pane);
    for (let i = 0; i < 5; i++) {
      output(verifier, pane);
      verifier.trigger('p1', 'input');
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(renders).toEqual([]);
    expect(verifier.trackedCount()).toBe(0);
  });

  it('holds one render in flight per pane and coalesces triggers into one follow-up', async () => {
    const pane: FakePane = { awaiting: true, eligible: true, mark: 0, rows: DIALOG_ROWS };
    let release: ((frame: AwaitingFrame | null) => void) | null = null;
    let calls = 0;
    const { verifier } = makeVerifier(pane, {
      render: () => {
        calls += 1;
        return new Promise<AwaitingFrame | null>((resolve) => {
          const mark = pane.mark;
          release = (f) => resolve(f ?? { rows: DIALOG_ROWS, mark });
        });
      },
    });
    output(verifier, pane);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    for (let i = 0; i < 25; i++) {
      output(verifier, pane);
      verifier.trigger('p1', 'input');
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(calls).toBe(1);
    release!(null);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
  });

  it('backs off while a dialog stays up under constant output, and input resets it', async () => {
    const pane: FakePane = { awaiting: true, eligible: true, mark: 0, rows: DIALOG_ROWS };
    const { verifier, renders } = makeVerifier(pane);
    // A subagent painting behind the dialog: output every 100 ms for a minute.
    for (let t = 0; t < 60_000; t += 100) {
      output(verifier, pane);
      await vi.advanceTimersByTimeAsync(100);
    }
    const steady = renders.length;
    expect(steady).toBeLessThan(30);
    // A human types: the next check comes quickly again.
    verifier.trigger('p1', 'input');
    output(verifier, pane);
    await vi.advanceTimersByTimeAsync(300);
    expect(renders.length).toBeGreaterThan(steady);
  });

  it('new output after the second dialog-free frame restarts verification instead of releasing', async () => {
    const pane: FakePane = { awaiting: true, eligible: true, mark: 0, rows: CLEAR_ROWS };
    let renders = 0;
    const { verifier, cleared } = makeVerifier(pane, {
      render: async () => {
        renders += 1;
        const frame = { rows: pane.rows!, mark: pane.mark };
        // Output lands right after the second read, before the release.
        if (renders === 2) pane.mark += 1;
        return frame;
      },
    });
    output(verifier, pane);
    await vi.advanceTimersByTimeAsync(900);
    expect(renders).toBe(2);
    expect(cleared).toEqual([]);
    // Verification restarts on its own and needs two fresh reads.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(renders).toBe(4);
    expect(cleared).toEqual(['p1']);
  });

  it('a failed render records nothing and is retried a bounded number of times', async () => {
    const pane: FakePane = { awaiting: true, eligible: true, mark: 0, rows: null };
    const { verifier, renders, cleared } = makeVerifier(pane);
    output(verifier, pane);
    await vi.advanceTimersByTimeAsync(60_000);
    // First read plus the bounded retries, with no new output in between.
    expect(renders).toHaveLength(1 + AWAITING_VERIFY_RENDER_RETRIES);
    // Once the grid reads again, the retries' same bytes are verified normally.
    pane.rows = CLEAR_ROWS;
    output(verifier, pane);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cleared).toEqual(['p1']);
  });

  it('dialog text left in the output above does not hold the pane', async () => {
    const pane: FakePane = {
      awaiting: true, eligible: true, mark: 0,
      rows: [...DIALOG_ROWS, '', '● Bash(ls)', '  ⎿  a b c', '', '✻ Working… (esc to interrupt)', '> ', '  ⏵⏵ bypass permissions on'],
    };
    const { verifier, cleared } = makeVerifier(pane);
    output(verifier, pane);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cleared).toEqual(['p1']);
  });

  it('a render that throws is not an unhandled rejection, and the pane stays awaiting', async () => {
    const pane: FakePane = { awaiting: true, eligible: true, mark: 0, rows: CLEAR_ROWS };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { verifier, cleared } = makeVerifier(pane, {
        render: async () => { throw new Error('parse exploded'); },
        outputMark: () => { if (pane.mark > 30) throw new Error('ring gone'); return pane.mark; },
      });
      for (let i = 0; i < 5; i++) {
        output(verifier, pane);
        await vi.advanceTimersByTimeAsync(2_000);
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(cleared).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('does not re-render when no output arrived since the last verified frame', async () => {
    const pane: FakePane = { awaiting: true, eligible: true, mark: 0, rows: DIALOG_ROWS };
    const { verifier, renders } = makeVerifier(pane);
    output(verifier, pane);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 10; i++) {
      verifier.trigger('p1', 'input');
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(renders).toHaveLength(1);
  });
});

// ── renderPaneScreen geometry ────────────────────────────────────────────────

function renderablePane(overrides: Partial<RenderablePane> = {}): RenderablePane {
  const ring = new RingBuffer(4096);
  ring.write(Buffer.from('hello'));
  return {
    meta: { cols: 80, rows: 24 },
    ptyProcess: {},
    ringBuffer: ring,
    bridge: { isMuted: false },
    ...overrides,
  };
}

describe('renderPaneScreen', () => {
  it('renders at the PTY size when node-pty reports one, else at the recorded size', async () => {
    const seen: Array<{ cols: number; rows: number }> = [];
    const snapshot = async (req: { cols: number; rows: number }) => {
      seen.push({ cols: req.cols, rows: req.rows });
      return { ok: true as const, rows: [{ text: 'x' }] };
    };
    const live = renderablePane({ meta: { cols: 80, rows: 24 }, ptyProcess: { cols: 120, rows: 40 } });
    const recorded = renderablePane();
    expect(await renderPaneScreen(() => live, snapshot)).toMatchObject({ rows: ['x'], mark: 5 });
    await renderPaneScreen(() => recorded, snapshot);
    expect(seen).toEqual([{ cols: 120, rows: 40 }, { cols: 80, rows: 24 }]);
  });

  it('is unreadable when the pane was resized while the render waited', async () => {
    const pane = renderablePane({ ptyProcess: { cols: 100, rows: 30 } });
    const snapshot = async () => {
      pane.ptyProcess.cols = 60;
      return { ok: true as const, rows: [{ text: 'x' }] };
    };
    expect(await renderPaneScreen(() => pane, snapshot)).toBeNull();
  });

  it('is unreadable for a muted pane, a gone pane, or a failed parse', async () => {
    const ok = async () => ({ ok: true as const, rows: [{ text: 'x' }] });
    expect(await renderPaneScreen(() => renderablePane({ bridge: { isMuted: true } }), ok)).toBeNull();
    expect(await renderPaneScreen(() => undefined, ok)).toBeNull();
    expect(await renderPaneScreen(() => renderablePane(), async () => ({ ok: false as const }))).toBeNull();
  });
});

// ── End to end: real bridge, real ring, real headless parse ─────────────────

describe('AwaitingScreenVerifier end to end', () => {
  it('a dialog answered by a mouse click is released once the running frame is on screen', async () => {
    let dataHandler: ((data: string) => void) | null = null;
    const pty = {
      onData: (cb: (data: string) => void) => {
        dataHandler = cb;
        return { dispose: () => { dataHandler = null; } };
      },
      onExit: () => ({ dispose: () => undefined }),
    } as unknown as IPty;
    const ring = new RingBuffer(256 * 1024);
    const bridge = new DaemonPTYBridge();
    bridge.setupDataForwarding(pty, ring, 'p1');
    const answered: Array<{ sessionId: string; reason: string }> = [];
    bridge.on('answered', (e: { sessionId: string; reason: string }) => answered.push(e));
    const pane: RenderablePane = { meta: { cols: 100, rows: 30 }, ptyProcess: {}, ringBuffer: ring, bridge };
    const verifier = new AwaitingScreenVerifier({
      isAwaiting: () => bridge.isAwaitingHuman(),
      eligible: () => true,
      outputMark: () => ring.totalBytesWritten,
      render: () => renderPaneScreen(() => pane, generateTextSnapshot),
      clear: () => { bridge.clearAwaiting('screen-cleared'); },
      settleMs: 20,
      minGapMs: 5,
    });
    bridge.on('awaitingActivity', (e: { cause: 'input' | 'output'; answered?: boolean }) => {
      if (e.answered !== true) verifier.trigger('p1', e.cause);
    });

    try {
      dataHandler!(DIALOG_FRAME);
      bridge.noteAgentStatus('awaiting_input', true);
      // A click on "1. Yes": press and release, SGR encoded. Not a key.
      bridge.noteInput('\x1b[<0;6;13M\x1b[<0;6;13m');
      await new Promise((r) => setTimeout(r, 60));
      expect(bridge.isAwaitingHuman()).toBe(true);

      dataHandler!(RUNNING_FRAME);
      await vi.waitFor(() => expect(answered).toEqual([{ sessionId: 'p1', reason: 'screen-cleared' }]), { timeout: 3_000 });
      expect(bridge.getAgentStatus()).not.toBe('awaiting_input');
    } finally {
      verifier.dispose();
      bridge.cleanup();
    }
  });
});
