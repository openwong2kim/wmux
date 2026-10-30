// The daemon's folder-trust verdict for a session, read from its own ring:
// what main falls back to when the renderer has no screen for the pane.

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { folderTrustRefusal, folderTrustState, readFolderTrust, type FolderTrustDeps, type FolderTrustSession } from '../folderTrustState';
import { looksLikeFolderTrustDialog, readFolderTrustScreen } from '../approvals/approvalKeystrokes';
import {
  enqueueSnapshotJob, generateTextSnapshot, generateTextSnapshotUnqueued, runSmallSnapshotJob, SMALL_SNAPSHOT_CONCURRENCY,
} from '../HeadlessSnapshot';
import { renderPaneTail } from '../AwaitingScreenVerifier';
import { RingBuffer } from '../RingBuffer';
import { FOLDER_TRUST_DELIVERY_BUDGET_MS } from '../../shared/folderTrustWording';
import { deliberateSleep } from '../../test-utils/waitFor';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import type { TerminalPty } from '../../shared/terminalPty';
import type { NativeOutputChunk } from '../../shared/nativeTerminalCore';

// The real parse, observable: a test can see a whole-ring parse start inside
// the real lanes (the default parse, no `deps.snapshot`).
vi.mock('../HeadlessSnapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../HeadlessSnapshot')>();
  return { ...actual, generateTextSnapshotUnqueued: vi.fn(actual.generateTextSnapshotUnqueued) };
});

const fixtureRows = (name: string): string[] =>
  (JSON.parse(fs.readFileSync(path.join(__dirname, '../approvals/__tests__/fixtures/folder-trust', `${name}.json`), 'utf8')) as {
    screen: string[];
  }).screen;

/** A full-screen TUI's frame: each row placed by cursor position, as Claude Code draws. */
const frame = (rows: string[]): Buffer =>
  Buffer.from(`\x1b[2J${rows.map((row, i) => `\x1b[${i + 1};1H${row}`).join('')}`);

/** A live session whose ring holds `bytes`, written at `cols`×`rows`. */
function session(bytes: Buffer, cols: number, rows: number, over: Partial<FolderTrustSession> = {}): FolderTrustSession & { ringBuffer: RingBuffer } {
  const ring = new RingBuffer(1024 * 1024);
  ring.noteGeometry(cols, rows);
  ring.write(bytes);
  return {
    meta: { state: 'attached', cols, rows },
    ptyProcess: { cols, rows },
    ringBuffer: ring,
    bridge: { isMuted: false, outputModes: null, heldOutput: () => null },
    ...over,
  } as FolderTrustSession & { ringBuffer: RingBuffer };
}

const deps = (s: FolderTrustSession | undefined, over: Partial<FolderTrustDeps> = {}): FolderTrustDeps => ({
  getSession: () => s,
  log: () => undefined,
  ...over,
});

const CLAUDE = fixtureRows('claude-folder-trust-120x40');

/** A recovered session at 120x40 whose real bridge is muted, its ring holding the restored screen. */
function mutedSession(restored: string) {
  let handler: ((chunk: NativeOutputChunk) => void) | undefined;
  const pty = {
    onData: vi.fn(),
    onNativeData: (cb: typeof handler) => { handler = cb; return { dispose: () => { handler = undefined; } }; },
    onExit: () => ({ dispose() { /* no process in this fixture */ } }),
    write: vi.fn(),
  } as unknown as TerminalPty;
  const ring = new RingBuffer(1024 * 1024, 'node');
  vi.spyOn(ring, 'writeNativeChunk').mockImplementation((chunk) => ring.write(Buffer.from(chunk.text)));
  ring.noteGeometry(120, 40);
  ring.write(Buffer.from(restored));
  const bridge = new DaemonPTYBridge();
  bridge.setupDataForwarding(pty, ring, 'muted-session');
  bridge.setMuted(true);
  cleanups.push(() => { bridge.cleanup(); ring.dispose(); });
  const s: FolderTrustSession & { resizedWhileMuted?: boolean } = {
    meta: { state: 'detached', cols: 120, rows: 40 },
    ptyProcess: { cols: 120, rows: 40 },
    ringBuffer: ring,
    bridge,
  };
  const feed = (text: string): void => handler?.({ text, byteLength: Buffer.byteLength(text), readBytes: () => Buffer.from(text), dispose: () => undefined } as unknown as NativeOutputChunk);
  return { session: s, bridge, ring, feed };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('folderTrustState', () => {
  it("is 'trust' when the ring's screen is the dialog", async () => {
    expect(await folderTrustState(deps(session(frame(CLAUDE), 120, 40)), 'pty-1')).toBe('trust');
    const codex = fixtureRows('codex-folder-trust-60x30');
    expect(await folderTrustState(deps(session(frame(codex), 60, 30)), 'pty-1')).toBe('trust');
  });

  it("is 'clear' for an ordinary screen, and for a dialog already answered", async () => {
    expect(await folderTrustState(deps(session(Buffer.from('⏺ Done.\r\n\r\n❯ '), 120, 40)), 'pty-1')).toBe('clear');
    // Measured after a daemon restart: the old dialog above a fresh shell prompt.
    const answered = Buffer.concat([frame(CLAUDE), Buffer.from(`\x1b[${CLAUDE.length + 1};1H% `)]);
    expect(await folderTrustState(deps(session(answered, 120, 40)), 'pty-1')).toBe('clear');
  });

  it('a dialog drawn at the spawn width, then a resize, is not read as clear', async () => {
    const s = session(frame(CLAUDE), 120, 40);
    s.ringBuffer.noteGeometry(60, 30);
    s.meta.cols = 60; s.meta.rows = 30;
    s.ptyProcess.cols = 60; s.ptyProcess.rows = 30;
    // Parsed whole at the new size, the cursor-placed rows overwrite each other.
    const naive = await generateTextSnapshot({ cols: 60, rows: 30, scrollback: 0, initial: s.ringBuffer.readAll() });
    expect(naive.ok && looksLikeFolderTrustDialog(naive.rows.map((r) => r.text))).toBe(false);
    expect(await folderTrustState(deps(s), 'pty-1')).not.toBe('clear');
  });

  it("is 'unknown' when cells the ring dropped could complete a dialog partly on screen", async () => {
    const ring = new RingBuffer(2048);
    ring.noteGeometry(120, 40);
    ring.write(frame(CLAUDE));
    // Only the grant choice is redrawn after the dialog's own draw left the ring.
    const yes = CLAUDE.findIndex((row) => row.includes('Yes, I trust this folder')) + 1;
    for (let n = 0; n < 80; n++) ring.write(Buffer.from(`\x1b[${yes};1H   Yes, I trust this folder`));
    const s = { ...session(Buffer.alloc(0), 120, 40), ringBuffer: ring };
    expect(await folderTrustState(deps(s), 'pty-1')).toBe('unknown');
  });

  it("is 'unknown' for a trust question over choices cut too short to read (18 columns)", async () => {
    const gemini = fixtureRows('gemini-folder-trust-18x60');
    expect(await folderTrustState(deps(session(frame(gemini), 18, 60)), 'pty-1')).toBe('unknown');
    const qwen = fixtureRows('qwen-folder-trust-18x60');
    expect(await folderTrustState(deps(session(frame(qwen), 18, 60)), 'pty-1')).toBe('unknown');
  });

  it("is 'unknown' when only the question of Gemini CLI's 18-column dialog left the ring", async () => {
    // The box and the notice a first Ctrl+C prints under it, in two rows: the
    // question is 40 rows from the last row with content. Each row is written
    // out to the pane's width, so its own cells are all known.
    const rows = fixtureRows('gemini-folder-trust-ctrlc-18x60').map((row) => row.padEnd(18));
    const question = rows.findIndex((row) => row.includes('Do you trust'));
    expect(rows.length - question).toBe(40);
    const ring = new RingBuffer(4096);
    // Exactly as tall as the screen drawn, so no row under it was never written.
    ring.noteGeometry(18, rows.length);
    ring.write(frame(rows));
    // Every row under the question is redrawn after the dialog's own draw left the ring.
    for (let n = 0; n < 20; n++) {
      ring.write(Buffer.from(rows.slice(question + 1).map((row, i) => `\x1b[${question + 2 + i};1H${row}`).join('')));
    }
    const s = { ...session(Buffer.alloc(0), 18, rows.length), ringBuffer: ring };
    expect(await folderTrustState(deps(s), 'pty-1')).toBe('unknown');
  });

  it("is 'clear' for a rolled ring whose only unseen cell is a header far above the prompt", async () => {
    const ring = new RingBuffer(16 * 1024);
    // Taller than the tallest dialog (44 rows): the header is 59 rows above the prompt.
    ring.noteGeometry(80, 60);
    ring.write(Buffer.from('\x1b[2J\x1b[1;1HHEADER'));
    // A full-screen TUI redraws every row but its header, until the header's draw leaves the ring.
    for (let n = 0; n < 60; n++) {
      for (let row = 2; row <= 59; row++) ring.write(Buffer.from(`\x1b[${row};1H\x1b[2Kline ${n}.${row}`));
      ring.write(Buffer.from('\x1b[60;1H\x1b[2K% '));
    }
    expect(ring.totalBytesWritten).toBeGreaterThan(ring.size);
    const s = { ...session(Buffer.alloc(0), 80, 60), ringBuffer: ring };
    expect(await folderTrustState(deps(s), 'pty-1')).toBe('clear');
  });

  it('reads a dialog line replayed at 40 columns across 3 rows, with a wrap on a blank', async () => {
    // A 120-column question row whose second 40-column row ends in the blank after "created".
    const head = ' Is this a project you created';
    const line = `${' Accessing /private/tmp/'.padEnd(79 - head.length, 'x')}${head} or one you trust? (Like your own code)`;
    expect(line[79]).toBe(' ');
    const q = CLAUDE.findIndex((row) => row.includes('Quick safety check'));
    const rows = [
      ...CLAUDE.slice(0, q).map((text) => ({ text, wrapped: false })),
      { text: line.slice(0, 40), wrapped: false },
      // The read trims the row's trailing blank.
      { text: line.slice(40, 79), wrapped: true },
      { text: line.slice(80), wrapped: true },
      ...CLAUDE.slice(q + 1).map((text) => ({ text, wrapped: false })),
    ];
    const snapshot = async () => ({ ok: true as const, rows });
    expect(await folderTrustState(deps(session(Buffer.from('x'), 40, 40), { snapshot }), 'pty-1')).toBe('trust');
  });

  it('reads a ring larger than the tail window from its tail, within the budget', async () => {
    const ring = new RingBuffer(8 * 1024 * 1024);
    ring.noteGeometry(120, 40);
    for (let n = 0; n < 60_000; n++) ring.write(Buffer.from(`\x1b[${(n % 38) + 1};1H${'y'.repeat(100)}`));
    ring.write(frame(CLAUDE));
    expect(ring.size).toBeGreaterThan(3 * 1024 * 1024);
    const s = { ...session(Buffer.alloc(0), 120, 40), ringBuffer: ring };
    // A slower machine: a whole-ring parse outlasts the budget, a tail parse does not.
    const snapshot: NonNullable<FolderTrustDeps['snapshot']> = async (req) => {
      if (req.initial.length > 1024 * 1024) await deliberateSleep(400, 'a whole-ring parse on a slow machine, inside the stub');
      return generateTextSnapshot(req);
    };
    const started = Date.now();
    expect(await folderTrustState(deps(s, { snapshot }), 'pty-1')).toBe('trust');
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("is 'clear' without a read when nothing runs in the session", async () => {
    const snapshot = vi.fn();
    for (const state of ['suspended', 'dead'] as const) {
      const s = session(frame(CLAUDE), 120, 40, { meta: { state, cols: 120, rows: 40 } });
      expect(await folderTrustState(deps(s, { snapshot }), 'pty-1')).toBe('clear');
    }
    // Not held at all: a recovery placeholder, a record kept only on disk, a closed pane.
    expect(await folderTrustState(deps(undefined, { snapshot }), 'pty-gone')).toBe('clear');
    expect(snapshot).not.toHaveBeenCalled();
  });

  describe('a muted (recovered, not yet shown) session: ring and held output read together', () => {
    it("is 'trust' when the held output draws the dialog, and the unmute still releases it", async () => {
      const m = mutedSession('% old prompt\r\n');
      m.feed(frame(CLAUDE).toString());
      expect(m.ring.readAll().toString()).toBe('% old prompt\r\n');
      expect(await folderTrustState(deps(m.session), 'pty-1')).toBe('trust');
      m.bridge.setMuted(false, { replayHeld: true });
      expect(m.ring.readAll().toString()).toContain('Yes, I trust this folder');
    });

    it("is 'clear' for a fresh shell, even over a restored dialog", async () => {
      const m = mutedSession(frame(CLAUDE).toString());
      m.feed(`\x1b[${CLAUDE.length + 1};1H% `);
      expect(await folderTrustState(deps(m.session), 'pty-1')).toBe('clear');
    });

    /** `bytes` of a resumed transcript, fed in chunks of about 16 KB. */
    const transcript = (m: ReturnType<typeof mutedSession>, bytes: number): void => {
      for (let fed = 0, n = 0; fed < bytes; ) {
        let chunk = '';
        while (chunk.length < 16 * 1024) chunk += `⏺ Resumed line ${n++}\r\n`;
        m.feed(chunk);
        fed += Buffer.byteLength(chunk);
      }
    };

    it("reads the output past the head the unmute replays (#2855): a prompt there is 'clear', a dialog 'trust'", async () => {
      const idle = mutedSession('');
      transcript(idle, 300 * 1024);
      idle.feed('\r\n❯ ');
      expect(await folderTrustState(deps(idle.session), 'pty-1')).toBe('clear');
      const m = mutedSession('');
      transcript(m, 300 * 1024);
      m.feed(frame(CLAUDE).toString());
      expect(await folderTrustState(deps(m.session), 'pty-1')).toBe('trust');
      // An unmute at the same size brings no repaint: it releases the head and
      // then the rest, so the pane shows the dialog that is up, not the start
      // of what the program printed.
      m.bridge.setMuted(false, { replayHeld: true });
      const replayed = m.ring.readAll().toString();
      expect(replayed).toContain('Resumed line 0\r\n');
      expect(replayed).toContain('Yes, I trust this folder');
      expect(await folderTrustState(deps(m.session), 'pty-1')).toBe('trust');
    });

    it('once the hold dropped output, reads its newest output alone, and a cell it never drew stays unknown', async () => {
      const m = mutedSession('');
      transcript(m, 3 * 1024 * 1024);
      expect(m.bridge.heldOutput()?.read().dropped).toBeGreaterThan(0);
      m.feed('\r\n❯ ');
      expect(await folderTrustState(deps(m.session), 'pty-1')).toBe('clear');
      m.feed(frame(CLAUDE).toString());
      expect(await folderTrustState(deps(m.session), 'pty-1')).toBe('trust');
      // Shown at the same size: the dialog drawn after the dropped output is replayed too.
      m.bridge.setMuted(false, { replayHeld: true });
      expect(await folderTrustState(deps(m.session), 'pty-1')).toBe('trust');
      // 3 MB that redraw one row by cursor address, with no line feed.
      const churn = (c: ReturnType<typeof mutedSession>): void => {
        for (let fed = 0, n = 0; fed < 3 * 1024 * 1024; n++) {
          const chunk = `\x1b[40;1H${n}`.padEnd(64, ' ').repeat(256);
          c.feed(chunk);
          fed += chunk.length;
        }
      };
      // Drawn before the dropped output and never redrawn: not known to be gone.
      const stale = mutedSession('');
      stale.feed(frame(CLAUDE).toString());
      churn(stale);
      expect(await folderTrustState(deps(stale.session), 'pty-1')).toBe('unknown');
      // Drawn by cursor address alone, a line feed only after it: read from the tail's first sequence.
      const addressed = mutedSession('');
      churn(addressed);
      addressed.feed(`${frame(CLAUDE).toString()}\x1b[1;1H\n`);
      expect(await folderTrustState(deps(addressed.session), 'pty-1')).toBe('trust');
      await enqueueSnapshotJob(async () => undefined);
    });

    it("is 'unknown' after a resize while muted dropped the held output", async () => {
      const m = mutedSession('');
      m.feed(frame(CLAUDE).toString());
      m.bridge.discardHeld();
      m.session.resizedWhileMuted = true;
      expect(await folderTrustState(deps(m.session), 'pty-1')).toBe('unknown');
    });
  });

  it("is 'unknown' when the parse fails or the pane is resized during it", async () => {
    const s = session(frame(CLAUDE), 120, 40);
    expect(await folderTrustState(deps(s, { snapshot: async () => ({ ok: false }) }), 'pty-1')).toBe('unknown');
    const resized = async (req: Parameters<NonNullable<FolderTrustDeps['snapshot']>>[0]) => {
      s.ptyProcess.cols = 100;
      return generateTextSnapshot(req);
    };
    expect(await folderTrustState(deps(s, { snapshot: resized }), 'pty-1')).toBe('unknown');
  });

  it("is 'unknown' once a read outlasts 250 ms, and its result is dropped", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const snapshot = vi.fn(() => new Promise<{ ok: false }>((resolve) => { release = () => resolve({ ok: false }); }));
    const verdict = folderTrustState(deps(session(frame(CLAUDE), 120, 40), { snapshot }), 'pty-1');
    let settled: string | undefined;
    void verdict.then((v) => { settled = v; });
    await vi.advanceTimersByTimeAsync(249);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe('unknown');
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it('answers within its budget while the shared snapshot queue is busy', async () => {
    let unblock: (() => void) | undefined;
    const busy = enqueueSnapshotJob(() => new Promise<void>((resolve) => { unblock = resolve; }));
    try {
      const started = Date.now();
      expect(await folderTrustState(deps(session(frame(CLAUDE), 120, 40)), 'pty-1')).toBe('trust');
      expect(Date.now() - started).toBeLessThan(250);
    } finally {
      unblock?.();
      await busy;
    }
  });
});

describe('a ring that outgrew the tail window, on a pane that went idle (#2855)', () => {
  // An agent's idle screen, drawn once.
  const IDLE = [
    ...Array.from({ length: 30 }, (_, i) => `⏺ Step ${i + 1} done.`),
    '',
    `╭${'─'.repeat(118)}╮`,
    `│ > ${' '.repeat(114)}│`,
    `╰${'─'.repeat(118)}╯`,
    '  ? for shortcuts',
  ];
  const spinner = (n: number): string => `\x1b[31;1H✻ Thinking… (${n}s · esc to interrupt)\x1b[K`;

  /** `first`, then a long stretch that redraws one row by cell diff, as ConPTY
   *  and Claude Code do: the rest of the screen is drawn only before the tail. */
  function longAfter(first: Buffer, redraw: (n: number) => string, end = ''): FolderTrustSession & { ringBuffer: RingBuffer } {
    const s = session(first, 120, 40);
    for (let n = 0; s.ringBuffer.totalBytesWritten < 600 * 1024; n++) s.ringBuffer.write(Buffer.from(redraw(n)));
    s.ringBuffer.write(Buffer.from(end));
    return s;
  }

  it("is 'clear' for an idle prompt the tail never redrew, and 'trust' for a dialog it never redrew", async () => {
    // The turn ends: its spinner row is cleared, the prompt box stays as drawn.
    const idle = longAfter(frame(IDLE), spinner, '\x1b[31;1H\x1b[K');
    expect(await folderTrustState(deps(idle), 'pty-1')).toBe('clear');
    const yes = CLAUDE.findIndex((row) => row.includes('Yes, I trust this folder')) + 1;
    const dialog = longAfter(frame(CLAUDE), () => `\x1b[${yes};1H   Yes, I trust this folder`);
    expect(await folderTrustState(deps(dialog), 'pty-1')).toBe('trust');
  });

  it('a printing pane whose mark moved since the last verdict still gets one decided', async () => {
    const s = longAfter(frame(IDLE), spinner, '\x1b[31;1H\x1b[K');
    let wholeParses = 0;
    const snapshot: NonNullable<FolderTrustDeps['snapshot']> = async (req) => {
      if (req.initial.length > 512 * 1024) wholeParses++;
      return generateTextSnapshotUnqueued(req);
    };
    expect(await readFolderTrust(deps(s, { snapshot }), 'pty-1')).toEqual({ state: 'clear' });
    expect(wholeParses).toBe(1);
    // Unchanged output: the kept verdict answers.
    expect(await readFolderTrust(deps(s, { snapshot }), 'pty-1')).toEqual({ state: 'clear' });
    expect(wholeParses).toBe(1);
    // The pane printed: the kept verdict is for older bytes, so the whole ring is read again, now.
    s.ringBuffer.write(Buffer.from(`${spinner(1)}\x1b[31;1H\x1b[K`));
    expect(await readFolderTrust(deps(s, { snapshot }), 'pty-1')).toEqual({ state: 'clear' });
    expect(wholeParses).toBe(2);
    // A dialog drawn since then is read too.
    s.ringBuffer.write(frame(CLAUDE));
    expect(await readFolderTrust(deps(s, { snapshot }), 'pty-1')).toEqual({ state: 'trust' });
  });

  it("a 250 ms request gets 'timeout' while the whole ring parses, and the parse goes on to answer the next request", async () => {
    const s = longAfter(frame(IDLE), spinner, '\x1b[31;1H\x1b[K');
    let parses = 0;
    let wholeParses = 0;
    const slow: NonNullable<FolderTrustDeps['snapshot']> = async (req) => {
      parses++;
      if (req.initial.length > 512 * 1024) {
        wholeParses++;
        await deliberateSleep(400, 'a whole-ring parse on a slow machine, inside the stub');
      }
      return generateTextSnapshotUnqueued(req);
    };
    const lines: string[] = [];
    const log = (line: string): void => { lines.push(line); };
    const started = Date.now();
    expect(await readFolderTrust(deps(s, { snapshot: slow, log }), 'pty-1')).toEqual({ state: 'unknown', reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(300);
    // A request that comes while it runs, for the same output, joins it on its own budget.
    expect(await readFolderTrust(deps(s, { snapshot: slow, log, timeoutMs: FOLDER_TRUST_DELIVERY_BUDGET_MS }), 'pty-1')).toEqual({ state: 'clear' });
    // After it: a 250 ms request at the same mark gets its verdict, with no parse at all.
    const before = parses;
    expect(await readFolderTrust(deps(s, { snapshot: slow, log }), 'pty-1')).toEqual({ state: 'clear' });
    expect(parses).toBe(before);
    expect(wholeParses).toBe(1);
    // One timing line per whole-ring parse: bytes, ms, wait, outcome.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[folder-trust\] whole-ring parse on pane pty-1: \d+ bytes in \d+ ms, after \d+ ms waiting: clear$/);
  });

  it('a request for bytes newer than the parse under way waits for it, then for one parse of its own bytes', async () => {
    const s = longAfter(frame(IDLE), spinner, '\x1b[31;1H\x1b[K');
    let wholeParses = 0;
    const slow: NonNullable<FolderTrustDeps['snapshot']> = async (req) => {
      if (req.initial.length > 512 * 1024) {
        wholeParses++;
        await deliberateSleep(300, 'a whole-ring parse on a slow machine, inside the stub');
      }
      return generateTextSnapshotUnqueued(req);
    };
    const first = readFolderTrust(deps(s, { snapshot: slow, timeoutMs: FOLDER_TRUST_DELIVERY_BUDGET_MS }), 'pty-1');
    await deliberateSleep(100, 'the first parse is under way');
    // The pane prints a dialog: the parse under way read the ring before it.
    s.ringBuffer.write(frame(CLAUDE));
    const second = readFolderTrust(deps(s, { snapshot: slow, timeoutMs: FOLDER_TRUST_DELIVERY_BUDGET_MS }), 'pty-1');
    expect(await first).toEqual({ state: 'clear' });
    // The newest output is the dialog, so the tail decides without the whole ring.
    expect(await second).toEqual({ state: 'trust' });
    expect(wholeParses).toBe(1);
    // Newer bytes whose tail cannot decide: the queued parse reads them.
    const t = longAfter(frame(IDLE), spinner, '\x1b[31;1H\x1b[K');
    const a = readFolderTrust(deps(t, { snapshot: slow, timeoutMs: FOLDER_TRUST_DELIVERY_BUDGET_MS }), 'pty-1');
    await deliberateSleep(100, 'the first parse is under way');
    t.ringBuffer.write(Buffer.from(`${spinner(1)}\x1b[31;1H\x1b[K`));
    const b = readFolderTrust(deps(t, { snapshot: slow, timeoutMs: FOLDER_TRUST_DELIVERY_BUDGET_MS }), 'pty-1');
    const c = readFolderTrust(deps(t, { snapshot: slow, timeoutMs: FOLDER_TRUST_DELIVERY_BUDGET_MS }), 'pty-1');
    expect(await Promise.all([a, b, c])).toEqual([{ state: 'clear' }, { state: 'clear' }, { state: 'clear' }]);
    // One parse for the older bytes, one shared by both requests for the newer.
    expect(wholeParses).toBe(3);
  });

  it("a ring past the parse's own budget is parsed again after the retry window, though the pane printed nothing", async () => {
    const s = longAfter(frame(IDLE), spinner, '\x1b[31;1H\x1b[K');
    let wholeParses = 0;
    const snapshot: NonNullable<FolderTrustDeps['snapshot']> = async (req) => {
      if (req.initial.length <= 512 * 1024) return generateTextSnapshotUnqueued(req);
      wholeParses++;
      return { ok: false, reason: 'budget' };
    };
    const log = (): void => {};
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(now);
      await readFolderTrust(deps(s, { snapshot, log }), 'pty-1');
      clock.mockReturnValue(now + 10_000);
      await readFolderTrust(deps(s, { snapshot, log }), 'pty-1');
      expect(wholeParses).toBe(1);
      clock.mockReturnValue(now + 31_000);
      await readFolderTrust(deps(s, { snapshot, log }), 'pty-1');
      expect(wholeParses).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("a ring that does not parse within the parse's own budget is kept as 'unknown' until the pane prints", async () => {
    const s = longAfter(frame(IDLE), spinner, '\x1b[31;1H\x1b[K');
    let wholeParses = 0;
    const snapshot: NonNullable<FolderTrustDeps['snapshot']> = async (req) => {
      if (req.initial.length <= 512 * 1024) return generateTextSnapshotUnqueued(req);
      wholeParses++;
      return { ok: false, reason: 'budget' };
    };
    const lines: string[] = [];
    const log = (line: string): void => { lines.push(line); };
    expect(await readFolderTrust(deps(s, { snapshot, log }), 'pty-1')).toEqual({ state: 'unknown', reason: 'unreadable' });
    expect(await readFolderTrust(deps(s, { snapshot, log }), 'pty-1')).toEqual({ state: 'unknown', reason: 'unreadable' });
    expect(wholeParses).toBe(1);
    expect(lines[0]).toMatch(/: not decided \(past its \d+ ms budget\)$/);
    s.ringBuffer.write(Buffer.from(`${spinner(1)}\x1b[31;1H\x1b[K`));
    expect(await readFolderTrust(deps(s, { snapshot, log }), 'pty-1')).toEqual({ state: 'unknown', reason: 'unreadable' });
    expect(wholeParses).toBe(2);
  });

  it("reads the whole ring when the tail shows a trust question over cut choices, and a dialog it holds is 'trust'", async () => {
    // 60x30: a narrow dialog's cut choices at the top, redrawn all along; a
    // whole dialog under it, drawn once before the tail.
    const top = ['Do you trust the files in this folder?', '› 1. Tr…', '  2. Do…'];
    const whole = ['Do you trust the files in this folder?', '› 1. Trust folder', "  2. Don't trust", 'Enter to confirm · Esc to cancel'];
    const s = session(Buffer.from(`\x1b[2J${[...top.map((row, i) => `\x1b[${i + 1};1H${row}`), ...whole.map((row, i) => `\x1b[${i + 10};1H${row}`)].join('')}`), 60, 30);
    for (let n = 0; s.ringBuffer.totalBytesWritten < 600 * 1024; n++) {
      s.ringBuffer.write(Buffer.from(top.map((row, i) => `\x1b[${i + 1};1H\x1b[2K${row}`).join('')));
    }
    // The tail alone reads the cut choices: the dialog under them is cells it never drew.
    const tail = await renderPaneTail(() => s, generateTextSnapshotUnqueued);
    expect(tail && readFolderTrustScreen(tail)).toBe('unreadable');
    expect(await readFolderTrust(deps(s), 'pty-1')).toEqual({ state: 'trust' });
  });

  it('a whole-ring parse runs in a lane of its own: it decides within a delivery budget while attach flushes hold the small slots, and leaves those slots free', async () => {
    const s = longAfter(frame(IDLE), spinner, '\x1b[31;1H\x1b[K');
    const actual = await vi.importActual<typeof import('../HeadlessSnapshot')>('../HeadlessSnapshot');
    // How many small slots a new pane's attach flush could take while the whole ring parses.
    const freeSlots: number[] = [];
    vi.mocked(generateTextSnapshotUnqueued).mockImplementation(async (req) => {
      if (req.initial.length > 512 * 1024) {
        let free = 0;
        for (let n = 0; n < SMALL_SNAPSHOT_CONCURRENCY; n++) void runSmallSnapshotJob(async () => { free++; });
        freeSlots.push(free);
      }
      return actual.generateTextSnapshotUnqueued(req);
    });
    // Attach flushes hold every small slot when the request comes, and other
    // panes' snapshots hold the shared queue.
    const flushes = Array.from({ length: SMALL_SNAPSHOT_CONCURRENCY }, () =>
      runSmallSnapshotJob(() => deliberateSleep(150, 'an attach flush holding a small slot')));
    let unblock: (() => void) | undefined;
    const busy = enqueueSnapshotJob(() => new Promise<void>((resolve) => { unblock = resolve; }));
    try {
      const started = Date.now();
      expect(await readFolderTrust(deps(s, { timeoutMs: FOLDER_TRUST_DELIVERY_BUDGET_MS }), 'pty-1')).toEqual({ state: 'clear' });
      expect(Date.now() - started).toBeLessThan(FOLDER_TRUST_DELIVERY_BUDGET_MS);
      expect(freeSlots).toEqual([SMALL_SNAPSHOT_CONCURRENCY]);
    } finally {
      vi.mocked(generateTextSnapshotUnqueued).mockImplementation(actual.generateTextSnapshotUnqueued);
      unblock?.();
      await Promise.all([busy, ...flushes]);
    }
  });

  it('a muted session past the head the unmute replays reads its held output whole too', async () => {
    const m = mutedSession('');
    m.feed(frame(IDLE).toString());
    for (let fed = 0, n = 0; fed < 600 * 1024; ) {
      let chunk = '';
      while (chunk.length < 16 * 1024) chunk += spinner(n++);
      m.feed(chunk);
      fed += Buffer.byteLength(chunk);
    }
    m.feed('\x1b[31;1H\x1b[K');
    expect(await folderTrustState(deps(m.session), 'pty-1')).toBe('clear');
    await enqueueSnapshotJob(async () => undefined);
  });
});

describe('a rolled ring on a pane that keeps printing: cells no byte left in the ring drew', () => {
  /** A ring smaller than what the pane printed: `first` is drawn once, then
   *  `rows` (screen row → text, each line erased first so all its cells are
   *  known) are redrawn until the first draw left the ring and the tail. */
  function printing(cols: number, height: number, first: Buffer, rows: (n: number) => Array<[number, string]>): FolderTrustSession & { ringBuffer: RingBuffer } {
    const ring = new RingBuffer(256 * 1024);
    ring.noteGeometry(cols, height);
    ring.write(first);
    for (let n = 0; ring.totalBytesWritten < 1024 * 1024; n++) {
      ring.write(Buffer.from(rows(n).map(([row, text]) => `\x1b[${row};1H\x1b[2K${text}`).join('')));
    }
    return { ...session(Buffer.alloc(0), cols, height), ringBuffer: ring };
  }

  it("stays 'unknown' when the unseen cells hold a startup trust question, with no prompt box under it", async () => {
    // Gemini CLI's boxed dialog, as tall as the screen: its question is drawn once,
    // every row under it redrawn.
    const gemini = fixtureRows('gemini-folder-trust-120x40').map((row) => row.padEnd(120));
    const question = gemini.findIndex((row) => row.includes('Do you trust'));
    const geminiPane = printing(120, gemini.length, frame(gemini), () => gemini.slice(question + 1).map((text, i) => [question + 2 + i, text]));
    expect(await readFolderTrust(deps(geminiPane), 'pty-1')).toEqual({ state: 'unknown', reason: 'unseen-cells' });
    // Claude Code's dialog: under the question, its explanation, then its choices and key hint.
    const claude = fixtureRows('claude-folder-trust-60x30');
    const q = claude.findIndex((row) => row.includes('Is this a project'));
    const claudePane = printing(60, claude.length, frame(claude), () => claude.slice(q + 1).map((text, i) => [q + 2 + i, text]));
    expect(await readFolderTrust(deps(claudePane), 'pty-1')).toEqual({ state: 'unknown', reason: 'unseen-cells' });
  });

  it("stays 'unknown' when only a narrow dialog's last wrapped row was redrawn", async () => {
    // At 22 columns the key hint wraps: its first row is unseen, "cancel" was redrawn.
    const rows = ['Do you trust the files', 'in this folder?', '› 1. Trust folder', '  2. Don\'t trust', 'Enter to confirm · Esc', 'to cancel'];
    const s = printing(22, rows.length, frame(rows), () => [[6, rows[5]]]);
    expect(await readFolderTrust(deps(s), 'pty-1')).toEqual({ state: 'unknown', reason: 'unseen-cells' });
  });

  it("is 'trust' when the dialog itself is the newest output", async () => {
    const s = printing(120, 40, frame(CLAUDE), (n) => [[1, `churn ${n}`]]);
    s.ringBuffer.write(frame(CLAUDE));
    expect(await readFolderTrust(deps(s), 'pty-1')).toEqual({ state: 'trust' });
  });
});

describe('folderTrustRefusal', () => {
  it("refuses on 'trust' with one log line, and on 'unknown' only for an automated writer", async () => {
    const lines: string[] = [];
    const log = (message: string): void => { lines.push(message); };
    const held = (s: FolderTrustSession) => ({ getSession: () => s });
    const trust = held(session(frame(CLAUDE), 120, 40));
    expect(await folderTrustRefusal(trust, 'pty-1', 'scheduled prompt', { refuseUnknown: false, log })).toBe('trust');
    const muted = held(session(Buffer.from('% '), 120, 40, { bridge: { isMuted: true, outputModes: null, heldOutput: () => null } }));
    expect(await folderTrustRefusal(muted, 'pty-2', 'chat send', { refuseUnknown: false, log })).toBeNull();
    expect(await folderTrustRefusal(muted, 'pty-2', 'wake nudge', { refuseUnknown: true, log })).toBe('unknown');
    const shell = held(session(Buffer.from('% '), 120, 40));
    expect(await folderTrustRefusal(shell, 'pty-3', 'wake nudge', { refuseUnknown: true, log })).toBeNull();
    expect(lines).toEqual([
      '[folder-trust] refused scheduled prompt on pane pty-1: folder-trust trust',
      '[folder-trust] refused wake nudge on pane pty-2: folder-trust unknown (muted)',
    ]);
  });
});

describe("the daemon's writers and their folder-trust policy", () => {
  // Automated writers stop on 'trust' and 'unknown'; a person's (a chat Stop
  // or Rewind, Continue on another account, a manual usage-limit Continue, the
  // first-run sample command) and any Escape only on 'trust'.
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');

  it.each([
    ['a prompt delivery (schedule, run, nudge) by default', "trustRefusal(sessionManager, id, writer, trust.refuseUnknown ?? true, { once: true, budgetMs: FOLDER_TRUST_DELIVERY_BUDGET_MS })"],
    ['the usage-limit continue: only the armed one', "'usage-limit continue', { refuseUnknown: armed, onRefused: () => { refused = true; } });"],
    ['the scheduled-run retry continue: unknown too', "'automation retry', { refuseUnknown: true })"],
    ['both continues through the shared trust-checked delivery', "}, writer, trust);"],
    ['writeIfUnchanged: all but a line a person asked for', "const trustOpts = human ? { once: true } : { once: true, budgetMs: FOLDER_TRUST_DELIVERY_BUDGET_MS };"],
    ['writeIfUnchanged: the check, with those options', "trustRefusal(sessionManager, sessionId, human ? 'sample command' : 'launch line', !human, trustOpts)"],
    ['an automation key: Escape only at a prompt seen', "trustRefusal(sessionManager, id, 'automation key', sequence !== '\\x1b', { once: true, budgetMs: FOLDER_TRUST_DELIVERY_BUDGET_MS })"],
    ["a scheduled run's check: the raw verdict, on a delivery budget", 'folderTrustState: (id) => folderTrustState({ getSession: (sid) => sessionManager.getSession(sid), timeoutMs: FOLDER_TRUST_DELIVERY_BUDGET_MS }, id),'],
    ["a chat Stop or Rewind: only at a prompt seen", 'atFolderTrust: async (id, writer) => (await trustRefusal(sessionManager, id, writer, false)) !== null,'],
    ['Continue on another account: only at a prompt seen', "(await trustRefusal(sessionManager, sid, 'continue on account', false)) !== null,"],
    ['the wake worker: the raw verdict, on a delivery budget', 'folderTrustVerdict: (id) => folderTrustState({ getSession: (sid) => sessionManager.getSession(sid), timeoutMs: FOLDER_TRUST_DELIVERY_BUDGET_MS }, id),'],
    ['the wake worker forgets a dead pane', "sessionManager.on('session:died', (payload: { id: string }) => channelWakeWorkerRef?.forgetSession(payload.id));"],
    ['the wake worker forgets a destroyed pane', "sessionManager.on('session:destroyed', (payload: { id: string }) => channelWakeWorkerRef?.forgetSession(payload.id));"],
    ['the refusal log forgets a dead pane', "sessionManager.on('session:died', (payload: { id: string }) => trustRefusalLogged.delete(payload.id));"],
    ['the refusal log forgets a destroyed pane', "sessionManager.on('session:destroyed', (payload: { id: string }) => trustRefusalLogged.delete(payload.id));"],
  ])('%s', (_name, wiring) => {
    expect(src).toContain(wiring);
  });
});
