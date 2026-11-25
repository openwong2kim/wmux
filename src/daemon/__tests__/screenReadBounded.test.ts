// The screen-only readers of a busy agent's pane (StallWatch's screen, the
// headless question probe's folder-trust read) parse the ring's screen
// checkpoint and the bytes after it, not the whole ring, on a pane whose
// tail read always misses (Claude Code's fullscreen renderer: cells drawn
// once, then only the cells that change).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const parsed: number[] = [];
vi.mock('../HeadlessSnapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../HeadlessSnapshot')>();
  return {
    ...actual,
    generateTextSnapshotUnqueued: vi.fn((req: Parameters<typeof actual.generateTextSnapshotUnqueued>[0]) => {
      parsed.push(req.initial.length);
      return actual.generateTextSnapshotUnqueued(req);
    }),
  };
});

import { RingBuffer } from '../RingBuffer';
import { OutputModeTracker } from '../util/outputModeTracker';
import { enqueueSnapshotJob } from '../HeadlessSnapshot';
import { noteScreenOutput, screenCheckpointBytes } from '../screenCheckpoint';
import { queuedScreenTail, queuedScreenText } from '../queuedSessionText';
import { SCREEN_REFRESH_BYTES, TAIL_MISS_CAP } from '../guardedTailRead';
import { readFolderTrust } from '../folderTrustState';

const fixtureRows = (name: string): string[] =>
  (JSON.parse(fs.readFileSync(path.join(__dirname, '../approvals/__tests__/fixtures/folder-trust', `${name}.json`), 'utf8')) as { screen: string[] }).screen;

const COLS = 120;
const ROWS = 40;
const RING = 2 * 1024 * 1024;

function pane(paint: string[]) {
  const ring = new RingBuffer(RING);
  const modes = new OutputModeTracker();
  ring.noteGeometry(COLS, ROWS);
  const size = () => ({ cols: COLS, rows: ROWS });
  const write = (text: string): void => {
    ring.write(Buffer.from(text, 'utf8'));
    modes.feed(text, ring.totalBytesWritten);
    noteScreenOutput(ring, modes, size);
  };
  write('\x1b[?1049h\x1b[H\x1b[2J');
  // Drawn once: the screen's static rows never come back to the ring.
  paint.forEach((row, i) => write(`\x1b[${i + 1};1H${row}`));
  let n = 0;
  /** One spinner repaint: only the cells that change. */
  const frame = (): void => {
    n++;
    write(`\x1b[?2026h\x1b[${ROWS - 3};1H${'✻✶✳✢✽'[n % 5]}\x1b[${ROWS - 3};40H${n} tokens\x1b[K\x1b[?2026l`);
  };
  const session = {
    meta: { cols: COLS, rows: ROWS, state: 'attached' as const },
    ptyProcess: { cols: COLS, rows: ROWS },
    ringBuffer: ring,
    bridge: { outputModes: modes, isMuted: false, heldOutput: () => null },
  };
  return { ring, frame, session, sessions: { getSession: (id: string) => (id === 'pane' ? session : undefined) } };
}

/** Spinner frames until `bytes` more were written, letting the checkpoint jobs run. */
async function spin(p: ReturnType<typeof pane>, bytes: number): Promise<void> {
  const until = p.ring.totalBytesWritten + bytes;
  while (p.ring.totalBytesWritten < until) {
    for (let i = 0; i < 500 && p.ring.totalBytesWritten < until; i++) p.frame();
    await enqueueSnapshotJob(async () => undefined);
  }
  await enqueueSnapshotJob(async () => undefined);
}

const claudeScreen = (): string[] => [
  '⏺ started the task',
  ...Array.from({ length: ROWS - 6 }, (_, i) => `  line ${i}`),
  '',
  '✻ Ruminating… (esc to interrupt)',
  `╭${'─'.repeat(COLS - 2)}╮`,
  `│ > ${' '.repeat(COLS - 5)}│`,
];

afterEach(() => {
  parsed.length = 0;
});

describe("StallWatch's screen read on a wrapped ring", () => {
  it('parses the checkpoint and the bytes after it, not the whole ring, with the screen queuedScreenText reads', async () => {
    const p = pane(claudeScreen());
    await spin(p, RING + RING / 2);
    expect(p.ring.totalBytesWritten).toBeGreaterThan(RING);
    expect(screenCheckpointBytes(p.ring)).toBeGreaterThan(0);
    // Past the miss cap the tail is no longer tried: each read is the fallback alone.
    for (let i = 0; i <= TAIL_MISS_CAP; i++) {
      p.frame();
      await queuedScreenTail(p.sessions, 'pane', 'stallwatch');
    }
    p.frame();
    parsed.length = 0;
    const tail = await queuedScreenTail(p.sessions, 'pane', 'stallwatch');
    expect(tail?.ok).toBe(true);
    expect(parsed.length).toBe(1);
    // The whole ring was parsed before: RING bytes and more each read.
    expect(parsed[0]).toBeLessThan(RING / 4 + screenCheckpointBytes(p.ring) + 64 * 1024);
    const screen = await queuedScreenText(p.sessions, 'pane');
    if (!tail?.ok || !screen?.ok) throw new Error('read failed');
    expect(tail.rows.map((r) => r.text)).toEqual(screen.rows.map((r) => r.text));
    // The cells drawn once still read (the whole ring had lost them).
    expect(tail.rows[0].text).toBe('⏺ started the task');
    expect(tail.rows.some((r) => r.text.startsWith('╭─'))).toBe(true);
  });

  it('keeps the checkpoint close to the output it reads, so a later read parses little more than its grid', async () => {
    const p = pane(claudeScreen());
    await spin(p, RING + RING / 2);
    for (let i = 0; i <= TAIL_MISS_CAP; i++) {
      p.frame();
      await queuedScreenTail(p.sessions, 'pane', 'stallwatch');
    }
    // More than a refresh's worth after the checkpoint, but less than the ring's own quarter.
    await spin(p, SCREEN_REFRESH_BYTES + 32 * 1024);
    await queuedScreenTail(p.sessions, 'pane', 'stallwatch');
    await enqueueSnapshotJob(async () => undefined);
    p.frame();
    parsed.length = 0;
    await queuedScreenTail(p.sessions, 'pane', 'stallwatch');
    expect(parsed.length).toBe(1);
    expect(parsed[0]).toBeLessThan(screenCheckpointBytes(p.ring) + 16 * 1024);
  });

  it('parses nothing again while the ring has not moved', async () => {
    const p = pane(claudeScreen());
    await spin(p, RING + RING / 2);
    await queuedScreenTail(p.sessions, 'pane', 'stallwatch');
    parsed.length = 0;
    await queuedScreenTail(p.sessions, 'pane', 'stallwatch');
    expect(parsed).toEqual([]);
  });
});

describe("the question probe's folder-trust read on a wrapped ring", () => {
  it("reads a busy pane's screen from its checkpoint: 'clear', not 'unknown' over cells the ring lost, at a fraction of the ring", async () => {
    const p = pane(claudeScreen());
    await spin(p, RING + RING / 2);
    parsed.length = 0;
    const seen = await readFolderTrust({ getSession: (id) => p.sessions.getSession(id), timeoutMs: 5000, log: () => undefined }, 'pane');
    expect(seen).toEqual({ state: 'clear' });
    expect(Math.max(...parsed)).toBeLessThan(RING / 2);
    expect(parsed.reduce((a, b) => a + b, 0)).toBeLessThan(RING / 2);
    // The same output again: the kept verdict, no parse.
    parsed.length = 0;
    expect(await readFolderTrust({ getSession: (id) => p.sessions.getSession(id), timeoutMs: 5000, log: () => undefined }, 'pane')).toEqual({ state: 'clear' });
    expect(parsed).toEqual([]);
  });

  it('keeps the checkpoint close to the output by itself, with no StallWatch read on the pane', async () => {
    const p = pane(claudeScreen());
    await spin(p, RING + RING / 2);
    const probe = () => readFolderTrust({ getSession: (id) => p.sessions.getSession(id), timeoutMs: 5000, log: () => undefined }, 'pane');
    await probe();
    await spin(p, SCREEN_REFRESH_BYTES + 32 * 1024);
    await probe();
    await enqueueSnapshotJob(async () => undefined);
    p.frame();
    parsed.length = 0;
    expect(await probe()).toEqual({ state: 'clear' });
    expect(parsed.length).toBe(1);
    expect(parsed[0]).toBeLessThan(screenCheckpointBytes(p.ring) + 16 * 1024);
  });

  it("reads a dialog drawn once, long before the ring's tail, as 'trust'", async () => {
    const dialog = fixtureRows('claude-folder-trust-120x40');
    const p = pane(dialog);
    // Only a cell far from the dialog keeps changing (a clock in the corner).
    let n = 0;
    p.frame = () => {
      n++;
      const text = `\x1b[1;${COLS - 8}H${String(n % 100000).padStart(6, '0')}`;
      p.ring.write(Buffer.from(text, 'utf8'));
      p.session.bridge.outputModes.feed(text, p.ring.totalBytesWritten);
      noteScreenOutput(p.ring, p.session.bridge.outputModes, () => ({ cols: COLS, rows: ROWS }));
    };
    await spin(p, RING + RING / 2);
    parsed.length = 0;
    const seen = await readFolderTrust({ getSession: (id) => p.sessions.getSession(id), timeoutMs: 5000, log: () => undefined }, 'pane');
    expect(seen.state).toBe('trust');
    expect(parsed.reduce((a, b) => a + b, 0)).toBeLessThan(RING / 2);
  });
});
