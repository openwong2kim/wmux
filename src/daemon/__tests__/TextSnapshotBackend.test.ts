import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateRustSnapshot } from '../RustSnapshot';
import { selectTextSnapshot, getTextSnapshotBackendDiagnostics } from '../TextSnapshotBackend';
import { generateTextSnapshot, generateSnapshot, type SnapshotRequest, type TextSnapshotOutcome } from '../HeadlessSnapshot';
import { NATIVE_CELL_LIMIT, NATIVE_SNAPSHOT_MAX_INPUT_BYTES } from '../nativeSnapshotLimits';
import { NATIVE_CIRCUIT_COOLDOWNS_MS } from '../nativeCircuit';

vi.mock('../RustSnapshot', () => ({ generateRustSnapshot: vi.fn() }));
const native = vi.mocked(generateRustSnapshot);
const req: SnapshotRequest = { cols: 80, rows: 24, initial: Buffer.from('hello'), budgetMs: 1000 };
const success: TextSnapshotOutcome = { ok: true, rows: [{ text: 'hello', wrapped: false }], bufferType: 'normal', rowsBelowCursor: 0, bytesIn: 5, durationMs: 1 };
let moduleId = 0;
beforeEach(() => {
  // CI names the built core in WMUX_TERMINAL_CORE_MODULE, which nativeCorePath reads first: unset it here so the stub is the module.
  vi.stubEnv('WMUX_TERMINAL_CORE_MODULE', undefined);
  vi.stubEnv('WMUX_RUST_SNAPSHOT', 'text');
  vi.stubEnv('WMUX_RUST_SNAPSHOT_MODULE', `/test/native-${++moduleId}.cjs`);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetAllMocks(); });

describe('opt-in Rust text delivery', () => {
  it('reads the removed shadow mode as unset: Rust on the rust engine', async () => {
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'shadow');
    vi.stubEnv('WMUX_TERMINAL_CORE', 'rust');
    native.mockResolvedValueOnce(success);
    const reference = vi.fn(async () => success);
    expect(await selectTextSnapshot(req, reference)).toMatchObject({ ...success, durationMs: expect.any(Number) });
    expect(reference).not.toHaveBeenCalled();
  });

  it('reads the removed shadow mode as unset: Rust with WMUX_TERMINAL_CORE=node too (the Node engine is removed)', async () => {
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'shadow');
    vi.stubEnv('WMUX_TERMINAL_CORE', 'node');
    native.mockResolvedValueOnce(success);
    const reference = vi.fn(async () => success);
    expect(await selectTextSnapshot(req, reference)).toMatchObject({ ...success, durationMs: expect.any(Number) });
    expect(reference).not.toHaveBeenCalled();
  });

  it.each(['', 'off', 'unknown'])('leaves the reference authoritative with mode %s', async mode => {
    vi.stubEnv('WMUX_RUST_SNAPSHOT', mode);
    const reference = vi.fn(async () => success);
    expect(await selectTextSnapshot(req, reference)).toBe(success);
    expect(reference).toHaveBeenCalledWith(req);
    expect(native).not.toHaveBeenCalled();
  });

  it('delivers native text without executing xterm twice', async () => {
    native.mockResolvedValueOnce(success);
    const reference = vi.fn(async () => success);
    const before = getTextSnapshotBackendDiagnostics().native;
    expect(await selectTextSnapshot(req, reference)).toMatchObject({ ...success, durationMs: expect.any(Number) });
    expect(reference).not.toHaveBeenCalled();
    expect(native).toHaveBeenCalledWith({ ...req, budgetMs: 1000 }, 'text');
    expect(getTextSnapshotBackendDiagnostics().native).toBe(before + 1);
  });

  it('routes a destructive live drain directly to xterm', async () => {
    const drain = vi.fn().mockReturnValueOnce([Buffer.from(' world')]).mockReturnValue([]);
    const result = await generateTextSnapshot({ ...req, drainQueue: drain });
    expect(result).toMatchObject({ ok: true, rows: [{ text: 'hello world', wrapped: false }] });
    expect(native).not.toHaveBeenCalled();
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it.each([
    // Only its length is read before the skip: a ring above the daemon's largest.
    { cols: 1 }, { scrollback: 100000 }, { initial: { length: NATIVE_SNAPSHOT_MAX_INPUT_BYTES + 1 } as Buffer },
    // 1000 × (1000 + 5000) cells, and a grid past 4M cells reached only on the way through a
    // resize: rows change first at the old width, so 1000 × (1000 + 3500); each recorded size fits.
    { geometry: { start: { cols: 1000, rows: 1000 }, changes: [] } },
    { cols: 100, rows: 1000, scrollback: 3500, geometry: { start: { cols: 1000, rows: 10 }, changes: [{ offset: 0, cols: 100, rows: 1000 }] } },
  ])('keeps requests outside the native limits on xterm', async extra => {
    const reference = vi.fn(async () => success);
    expect(await selectTextSnapshot({ ...req, ...extra }, reference)).toBe(success);
    expect(native).not.toHaveBeenCalled();
  });

  it.each([
    ['a ring above the old 8 MiB cap', { initial: Buffer.alloc(16 * 1024 * 1024, 0x61) }],
    ['a 200-column pane with 5000 rows of history (past the old 1M cells)', { cols: 200, rows: 30, scrollback: 5000 }],
    ['a grid at the native cell limit', { cols: 400, rows: 30, scrollback: NATIVE_CELL_LIMIT / 400 - 30 }],
  ])('takes %s natively', async (_name, extra) => {
    const request = { ...req, ...extra };
    native.mockResolvedValue({ ...success, bytesIn: request.initial.length });
    const reference = vi.fn(async () => success);
    await selectTextSnapshot(request, reference);
    expect(native).toHaveBeenCalledOnce();
    expect(reference).not.toHaveBeenCalled();
  });

  it('replays the original bytes and geometry through real xterm on native failure', async () => {
    const request = { ...req, initial: Buffer.from('abc한글0123456789\r\nlast'), cols: 8,
      geometry: { start: { cols: 16, rows: 24 }, changes: [] } };
    vi.stubEnv('WMUX_RUST_SNAPSHOT', '');
    const baseline = await generateTextSnapshot(request);
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'text');
    native.mockImplementationOnce(async candidate => {
      expect(candidate.initial).toBe(request.initial);
      expect(candidate.geometry).toBe(request.geometry);
      throw new Error('load/feed/dispose failure');
    });
    const actual = await generateTextSnapshot(request);
    expect(actual).toMatchObject({ ...baseline, durationMs: expect.any(Number) });
    expect(getTextSnapshotBackendDiagnostics().circuitOpen).toBe(true);
  });

  it('avoids repeated broken-module loads and retries a changed module path', async () => {
    native.mockResolvedValueOnce({ ok: false, reason: 'error' }).mockResolvedValueOnce(success);
    const reference = vi.fn(async () => success);
    await selectTextSnapshot(req, reference);
    await selectTextSnapshot(req, reference);
    expect(native).toHaveBeenCalledTimes(1);
    expect(reference).toHaveBeenCalledTimes(2);
    vi.stubEnv('WMUX_RUST_SNAPSHOT_MODULE', '/test/repaired.cjs');
    await selectTextSnapshot(req, reference);
    expect(native).toHaveBeenCalledTimes(2);
    expect(reference).toHaveBeenCalledTimes(2);
    expect(getTextSnapshotBackendDiagnostics().circuitOpen).toBe(false);
  });

  // R2 (b) prep: the circuit no longer stays open for the life of the daemon (nativeCircuit.ts).
  it('retries a broken module once its cooldown ran out, and closes the circuit when it works', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    native.mockResolvedValueOnce({ ok: false, reason: 'error' }).mockResolvedValueOnce({ ok: false, reason: 'error' }).mockResolvedValueOnce(success);
    const reference = vi.fn(async () => success);
    await selectTextSnapshot(req, reference);
    now = NATIVE_CIRCUIT_COOLDOWNS_MS[0] - 1;
    await selectTextSnapshot(req, reference);
    expect(native).toHaveBeenCalledTimes(1);
    // The trial fails: open again, for the second cooldown.
    now = NATIVE_CIRCUIT_COOLDOWNS_MS[0];
    await selectTextSnapshot(req, reference);
    expect(native).toHaveBeenCalledTimes(2);
    expect(getTextSnapshotBackendDiagnostics()).toMatchObject({ circuitOpen: true, circuitFailures: 2 });
    now += NATIVE_CIRCUIT_COOLDOWNS_MS[1] - 1;
    await selectTextSnapshot(req, reference);
    expect(native).toHaveBeenCalledTimes(2);
    // The next trial works: closed.
    now += 1;
    expect(await selectTextSnapshot(req, reference)).toMatchObject({ ok: true });
    expect(native).toHaveBeenCalledTimes(3);
    expect(getTextSnapshotBackendDiagnostics()).toMatchObject({ circuitOpen: false, circuitFailures: 0 });
  });

  it('closes the circuit on a trial that ran out of budget: the module worked', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    native.mockResolvedValueOnce({ ok: false, reason: 'error' }).mockResolvedValueOnce({ ok: false, reason: 'budget' });
    const reference = vi.fn(async () => success);
    await selectTextSnapshot(req, reference);
    now = NATIVE_CIRCUIT_COOLDOWNS_MS[0];
    await selectTextSnapshot(req, reference);
    expect(getTextSnapshotBackendDiagnostics().circuitOpen).toBe(false);
  });

  it('rejects malformed native output and preserves the reference outcome', async () => {
    native.mockResolvedValueOnce({ ...success, bytesIn: 0 });
    const reference = vi.fn(async () => ({ ok: false as const, reason: 'budget' as const }));
    expect(await selectTextSnapshot(req, reference)).toEqual({ ok: false, reason: 'budget' });
    expect(getTextSnapshotBackendDiagnostics().circuitOpen).toBe(true);
  });

  it('gives fallback only the remaining budget and counts total duration', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    // Native has the whole budget; a failure 600 ms in leaves the reference the other 400.
    native.mockImplementationOnce(async () => { now = 600; return { ok: false, reason: 'error', detail: 'module fault' }; });
    const reference = vi.fn(async (captured: SnapshotRequest) => {
      expect(captured.budgetMs).toBe(400); now += 100; return success;
    });
    expect(await selectTextSnapshot(req, reference)).toMatchObject({ ok: true, durationMs: 700 });
    expect(native.mock.calls[0][0].budgetMs).toBe(1000);
  });

  it('does not restart an exhausted deadline, and reports it as native\'s, not a fallback', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    native.mockImplementationOnce(async () => { now = 1001; return { ok: false, reason: 'budget' }; });
    const reference = vi.fn(async () => success);
    const before = getTextSnapshotBackendDiagnostics();
    expect(await selectTextSnapshot(req, reference)).toEqual({ ok: false, reason: 'budget' });
    expect(reference).not.toHaveBeenCalled();
    const after = getTextSnapshotBackendDiagnostics();
    expect(after.fallbacks).toBe(before.fallbacks);
    expect(after.reasons.budget).toBe((before.reasons.budget ?? 0) + 1);
    expect(after.last).toEqual({ backend: 'rust', reason: 'budget' });
  });

  it('delivers a complete native result that ended just past the deadline', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    native.mockImplementationOnce(async () => { now = 1040; return success; });
    const reference = vi.fn(async () => success);
    const before = getTextSnapshotBackendDiagnostics().native;
    expect(await selectTextSnapshot(req, reference)).toMatchObject({ ok: true, durationMs: 1040 });
    expect(reference).not.toHaveBeenCalled();
    expect(getTextSnapshotBackendDiagnostics().native).toBe(before + 1);
  });

  it('does not load native code for a zero budget', async () => {
    const reference = vi.fn(async () => success);
    expect(await selectTextSnapshot({ ...req, budgetMs: 0 }, reference)).toEqual({ ok: false, reason: 'budget' });
    expect(native).not.toHaveBeenCalled();
    expect(reference).not.toHaveBeenCalled();
  });

  it('keeps ANSI restoration on xterm even when text delivery is enabled', async () => {
    const result = await generateSnapshot({ ...req, initial: Buffer.from('\x1b[5mblink') });
    expect(result.ok).toBe(true);
    expect(native).not.toHaveBeenCalled();
  });

  it('serializes concurrent native text jobs on the production queue', async () => {
    let active = 0, max = 0;
    native.mockImplementation(async () => {
      active++; max = Math.max(active, max);
      await new Promise<void>(resolve => setImmediate(resolve));
      active--; return success;
    });
    const results = await Promise.all(Array.from({ length: 6 }, () => generateTextSnapshot(req)));
    expect(results.every(r => r.ok)).toBe(true);
    expect(max).toBe(1);
    expect(native).toHaveBeenCalledTimes(6);
  });
});
