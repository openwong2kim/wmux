/**
 * #3510: a native snapshot yields to the event loop by parse time, not after
 * every 256 KiB slice. Under heavy output every yield costs a whole loop turn,
 * so per-slice yields stretched a parse ~20 times while it held the shared
 * snapshot queue. Each synchronous block still stays near 10 ms, so input and
 * output keep flowing during a parse.
 *
 * Timed on a fake clock the stubbed core advances by 1 ms per slice, so the
 * turn count and the block lengths are exact, whatever the machine's load.
 */
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NativeFrozenRing } from '../../shared/nativeTerminalCore';
import { generateRustSnapshot, SNAPSHOT_YIELD_AFTER_MS } from '../RustSnapshot';

const SLICE = 256 * 1024;
const SLICES = 40;
const clock = globalThis as typeof globalThis & { __wmuxYieldTestMs?: number };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-native-yield-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  const file = path.join(dir, 'slow.cjs');
  // A full slice of parse costs 1 ms on the fake clock; the empty preamble costs nothing.
  fs.writeFileSync(file, `
    const tick = () => { globalThis.__wmuxYieldTestMs += 1; };
    module.exports = {
      nativeCoreAbiVersion: () => 1,
      NativeTerminal: class {
        feed(bytes) { if (bytes.length >= ${SLICE}) tick(); }
        feedFrozen() { tick(); }
        resize() {}
        textSnapshot() { return { rows: [], bufferType: 'normal', rowsBelowCursor: 0 }; }
        dispose() {}
      },
    };`);
  vi.stubEnv('WMUX_TERMINAL_CORE_MODULE', undefined);
  vi.stubEnv('WMUX_RUST_SNAPSHOT_MODULE', file);
  clock.__wmuxYieldTestMs = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.__wmuxYieldTestMs ?? 0);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/**
 * Runs `work` while a setImmediate chain ticks beside it: the ticks it gets
 * are the loop turns the work yielded, and the longest fake-clock gap between
 * two ticks is the longest block the work held the loop for.
 */
async function probeLoop<T>(work: () => Promise<T>): Promise<{ result: T; turns: number; maxBlockMs: number }> {
  let running = true;
  let turns = 0;
  let maxBlockMs = 0;
  let last = performance.now();
  const tick = (): void => {
    if (!running) return;
    const now = performance.now();
    maxBlockMs = Math.max(maxBlockMs, now - last);
    last = now;
    turns++;
    setImmediate(tick);
  };
  setImmediate(tick);
  const result = await work();
  running = false;
  maxBlockMs = Math.max(maxBlockMs, performance.now() - last);
  return { result, turns, maxBlockMs };
}

const source = (): NativeFrozenRing => ({ size: SLICES * SLICE, readAll: () => Buffer.alloc(0), dispose: () => undefined }) as unknown as NativeFrozenRing;

it.each([
  ['bytes it was handed', () => ({ initial: Buffer.alloc(SLICES * SLICE, 0x61) })],
  ['a frozen native ring', () => ({ initial: Buffer.alloc(0), nativeSource: source() })],
])('feeds %s in blocks of the yield threshold, not one loop turn per slice', async (_name, input) => {
  const { result, turns, maxBlockMs } = await probeLoop(() => generateRustSnapshot({ cols: 80, rows: 24, scrollback: 100, budgetMs: 60_000, ...input() }, 'text'));
  expect(result).toMatchObject({ ok: true });
  expect(SNAPSHOT_YIELD_AFTER_MS).toBe(8);
  // 40 ms of parse in 8 ms blocks: 5 yields, plus the probe's first turn. Per-slice yields took 40.
  expect(turns).toBeGreaterThanOrEqual(2);
  expect(turns).toBeLessThanOrEqual(6);
  // A block ends at the first slice that reaches the threshold: never more than one slice past it.
  expect(maxBlockMs).toBeLessThanOrEqual(9);
});
