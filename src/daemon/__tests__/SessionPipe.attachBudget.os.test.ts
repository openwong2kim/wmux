// The attach snapshot over budget: the whole ring did not parse in time (seen
// on a live agent pane while the daemon was busy). A raw replay of a
// cursor-addressed app's history interleaves its redraws into garbage, so the
// flush retries on the ring's newest bytes and ships THAT snapshot.
import { describe, it, expect, afterEach, vi } from 'vitest';
import net from 'node:net';
import crypto from 'node:crypto';
import { Terminal } from '@xterm/headless';
import { RingBuffer } from '../RingBuffer';
// vi.mock below is hoisted above these imports, so SessionPipe gets the mock.
import { SessionPipe, createSessionPipeMarkers, ATTACH_TAIL_SNAPSHOT_BYTES, ATTACH_TAIL_SNAPSHOT_BUDGET_MS } from '../SessionPipe';
import { waitFor } from '../../test-utils/waitFor';

const calls: number[] = [];
const budgets: (number | undefined)[] = [];
let failAll = false;

vi.mock('../HeadlessSnapshot', async (importOriginal) => {
  const real = await importOriginal<typeof import('../HeadlessSnapshot')>();
  return {
    ...real,
    // Any parse bigger than the retry window runs out of budget.
    generateSnapshotUnqueued: async (req: Parameters<typeof real.generateSnapshotUnqueued>[0]) => {
      calls.push(req.initial.length);
      budgets.push(req.budgetMs);
      if (failAll || req.initial.length > 1024 * 1024 + 64) {
        return { ok: false as const, reason: 'budget' as const, detail: 'parsed=0/0 elapsedMs=4001' };
      }
      return real.generateSnapshotUnqueued(req);
    },
  };
});

const TOKEN = 'attbudget-test-token';
const FLUSH_DONE = createSessionPipeMarkers(TOKEN).flushDone;
const COLS = 100;
const ROWS = 24;

/** A TUI that repaints one small screen in place, megabytes of it. */
function redrawHistory(minBytes: number): Buffer {
  const parts: Buffer[] = [];
  let total = 0;
  for (let i = 0; total < minBytes; i++) {
    const b = Buffer.from(`\x1b[H\x1b[2Jframe ${i}\r\nstatus ${'.'.repeat(60)}\r\n`, 'utf8');
    parts.push(b);
    total += b.length;
  }
  return Buffer.concat(parts);
}

async function screenOf(data: Buffer): Promise<string[]> {
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true });
  try {
    await new Promise<void>((resolve) => term.write(data, resolve));
    const buf = term.buffer.active;
    return Array.from({ length: ROWS }, (_, y) => buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '');
  } finally {
    term.dispose();
  }
}

const sockets: net.Socket[] = [];
const pipes: SessionPipe[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const p of pipes.splice(0)) await p.stop().catch(() => {});
  calls.length = 0;
  budgets.length = 0;
  failAll = false;
});

async function attach(raw: Buffer): Promise<Buffer> {
  const ring = new RingBuffer(8 * 1024 * 1024);
  ring.write(raw);
  const pipe = new SessionPipe(`attbudget-${crypto.randomUUID().slice(0, 8)}`, ring, TOKEN, () => ({ cols: COLS, rows: ROWS }));
  pipes.push(pipe);
  await pipe.start();
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(pipe.getPipeName(), () => { socket.write(TOKEN + '\n'); resolve(); });
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('error', reject);
    sockets.push(socket);
  });
  const wire = () => Buffer.concat(chunks);
  await waitFor(() => wire().includes(FLUSH_DONE), 15_000);
  return wire().subarray(0, wire().indexOf(FLUSH_DONE));
}

describe('attach snapshot over budget', () => {
  it('retries on the newest bytes and ships a snapshot with the right screen, not the raw ring', async () => {
    const raw = redrawHistory(4 * 1024 * 1024);
    const replay = await attach(raw);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBeLessThanOrEqual(ATTACH_TAIL_SNAPSHOT_BYTES);
    // The retry holds the same queue slot, so it gets a short budget of its own.
    expect(budgets).toEqual([undefined, ATTACH_TAIL_SNAPSHOT_BUDGET_MS]);
    expect(replay.length).toBeLessThan(64 * 1024);
    expect(await screenOf(replay)).toEqual(await screenOf(raw));
  });

  it('falls back to raw only when the retry runs out of budget too', async () => {
    failAll = true;
    const raw = redrawHistory(2 * 1024 * 1024);
    const replay = await attach(raw);
    expect(calls).toHaveLength(2);
    expect(replay.equals(raw)).toBe(true);
  });
});
