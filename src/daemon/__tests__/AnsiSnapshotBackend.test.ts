import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAnsiSnapshotBackendDiagnostics, selectAnsiSnapshot } from '../AnsiSnapshotBackend';
import type { SnapshotOutcome, SnapshotRequest } from '../HeadlessSnapshot';
import { generateRustSnapshot } from '../RustSnapshot';
vi.mock('../RustSnapshot', () => ({ generateRustSnapshot: vi.fn() }));
const native = vi.mocked(generateRustSnapshot);
const request = { cols: 80, rows: 24, initial: Buffer.from('hello'), budgetMs: 1000 };
const success = { ok: true as const, payload: Buffer.from('hello'), bytesIn: 5, durationMs: 1 };
let moduleId = 0;
beforeEach(() => {
  vi.stubEnv('WMUX_RUST_SNAPSHOT', 'ansi');
  vi.stubEnv('WMUX_RUST_SNAPSHOT_MODULE', `/test/native-${++moduleId}.cjs`);
});
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
const nativeSuccess = (initial: Buffer) => native.mockResolvedValue({ ...success, bytesIn: initial.length } as never);
/** A candidate that drains the whole tee and parses every byte. */
const drainAll = (async (req: SnapshotRequest) => {
  let bytes = req.initial.length;
  for (let chunks = req.drainQueue!(); chunks.length; chunks = req.drainQueue!()) bytes += Buffer.concat(chunks).length;
  return { ...success, bytesIn: bytes };
}) as never;

describe('ANSI snapshot backend selection', () => {
  it('defaults to Rust on the rust terminal engine', async () => {
    vi.stubEnv('WMUX_RUST_SNAPSHOT', undefined);
    vi.stubEnv('WMUX_TERMINAL_CORE', 'rust');
    nativeSuccess(request.initial);
    const reference = vi.fn();
    expect(await selectAnsiSnapshot(request, reference)).toMatchObject({ ...success, durationMs: expect.any(Number) });
    expect(reference).not.toHaveBeenCalled();
    expect(getAnsiSnapshotBackendDiagnostics().last).toEqual({ backend: 'rust', reason: 'native' });
  });

  it.each([['off', 'rust'], [undefined, 'node']])('keeps xterm with mode %s on the %s engine', async (mode, engine) => {
    vi.stubEnv('WMUX_RUST_SNAPSHOT', mode);
    vi.stubEnv('WMUX_TERMINAL_CORE', engine);
    const reference = vi.fn(async () => success);
    expect(await selectAnsiSnapshot(request, reference)).toBe(success);
    expect(native).not.toHaveBeenCalled();
  });

  // Which controls Rust refuses is decided natively (native_serialize.rs
  // tests, RustAnsiParity.test.ts); here only the selector's reaction.
  it('falls back on a divergent-control refusal without opening the circuit', async () => {
    native.mockResolvedValue({ ok: false, reason: 'error', detail: 'unsupported-state: a control Alacritty parses differently' });
    const reference = vi.fn(async () => success);
    expect(await selectAnsiSnapshot(request, reference)).toMatchObject({ ...success, durationMs: expect.any(Number) });
    expect(getAnsiSnapshotBackendDiagnostics()).toMatchObject({ circuitOpen: false, last: { backend: 'xterm', reason: 'state' } });
  });

  it('replays the live tee drained by Rust into the xterm fallback', async () => {
    const queue = [[Buffer.from(' a')], [Buffer.from(' b')], [Buffer.from(' c')], []];
    const drainQueue = vi.fn(() => queue.shift() ?? []);
    native.mockImplementation(async req => {
      req.drainQueue!(); req.drainQueue!();
      return { ok: false, reason: 'error', detail: 'unsupported-wide-edge' };
    });
    const seen: Buffer[] = [];
    const reference = vi.fn(async (req: SnapshotRequest): Promise<SnapshotOutcome> => {
      for (let chunks = req.drainQueue!(); chunks.length; chunks = req.drainQueue!()) seen.push(...chunks);
      return success;
    });
    await selectAnsiSnapshot({ ...request, drainQueue }, reference);
    expect(Buffer.concat(seen).toString()).toBe(' a b c');
  });

  it('accepts a live tee whose drained bytes Rust parsed', async () => {
    const queue = [[Buffer.from('\x1b]0;t\x07x')], []];
    native.mockImplementation(drainAll);
    const reference = vi.fn();
    expect((await selectAnsiSnapshot({ ...request, drainQueue: () => queue.shift() ?? [] }, reference)).ok).toBe(true);
    expect(reference).not.toHaveBeenCalled();
  });

  it('replays drained bytes into the fallback when Rust refuses them', async () => {
    const queue = [[Buffer.from('\x1b(0q')], []];
    native.mockImplementation((async (req: SnapshotRequest) => {
      for (let chunks = req.drainQueue!(); chunks.length; chunks = req.drainQueue!()) { /* parsed, then refused */ }
      return { ok: false, reason: 'error', detail: 'unsupported-state: a control Alacritty parses differently' };
    }) as never);
    const seen: string[] = [];
    const reference = vi.fn(async (req: SnapshotRequest): Promise<SnapshotOutcome> => {
      seen.push(...req.drainQueue!().map(String)); return success;
    });
    await selectAnsiSnapshot({ ...request, drainQueue: () => queue.shift() ?? [] }, reference);
    expect(reference).toHaveBeenCalledOnce(); expect(seen).toEqual(['\x1b(0q']);
  });

  it('retries unsupported serialization with the remaining budget and original bytes', async () => {
    native.mockResolvedValue({ ok: false, reason: 'error', detail: 'unsupported-wide-edge' });
    const reference = vi.fn(async (req: SnapshotRequest) => { expect(req.initial).toBe(request.initial); return success; });
    await selectAnsiSnapshot(request, reference);
    expect(reference.mock.calls[0][0].budgetMs).toBeLessThanOrEqual(1000);
    expect(getAnsiSnapshotBackendDiagnostics()).toMatchObject({ circuitOpen: false, last: { backend: 'xterm', reason: 'unsupported' } });
  });

  it('opens the circuit on a module error until the module changes', async () => {
    native.mockRejectedValueOnce(new Error('load failed'));
    const reference = vi.fn(async () => success);
    await selectAnsiSnapshot(request, reference);
    expect(getAnsiSnapshotBackendDiagnostics().circuitOpen).toBe(true);
    await selectAnsiSnapshot(request, reference);
    expect(native).toHaveBeenCalledOnce();
    expect(getAnsiSnapshotBackendDiagnostics().last).toEqual({ backend: 'xterm', reason: 'circuit-open' });
    vi.stubEnv('WMUX_RUST_SNAPSHOT_MODULE', '/test/repaired.cjs');
    nativeSuccess(request.initial);
    await selectAnsiSnapshot(request, reference);
    expect(native).toHaveBeenCalledTimes(2);
  });

  it('takes an attach request: a full ring with its preamble and 100k rows of scrollback', async () => {
    const initial = Buffer.alloc(8 * 1024 * 1024 + 64, 0x61);
    nativeSuccess(initial);
    const reference = vi.fn();
    await selectAnsiSnapshot({ ...request, initial, scrollback: 100000 }, reference);
    expect(native).toHaveBeenCalledOnce(); expect(reference).not.toHaveBeenCalled();
  });

  it.each([
    ['an oversized input', { initial: Buffer.alloc(9 * 1024 * 1024) }],
    ['a scrollback above 100k', { scrollback: 100001 }],
    ['a recorded size above 1000 columns', { geometry: { start: { cols: 1001, rows: 24 }, changes: [] } }],
  ])('keeps xterm for %s', async (_name, change) => {
    const reference = vi.fn(async () => success);
    await selectAnsiSnapshot({ ...request, ...change }, reference);
    expect(native).not.toHaveBeenCalled();
    expect(getAnsiSnapshotBackendDiagnostics().last).toEqual({ backend: 'xterm', reason: 'limits' });
  });

  it('returns a margins refusal without parsing again on xterm', async () => {
    native.mockResolvedValue({ ok: false, reason: 'margins' });
    const reference = vi.fn();
    expect(await selectAnsiSnapshot(request, reference)).toEqual({ ok: false, reason: 'margins' });
    expect(reference).not.toHaveBeenCalled();
  });

  it('rejects a result that did not parse every byte', async () => {
    native.mockResolvedValue({ ...success, bytesIn: 4 } as never);
    const reference = vi.fn(async () => success);
    await selectAnsiSnapshot(request, reference);
    expect(reference).toHaveBeenCalledOnce();
  });

  it('hands both backends the frozen native history as bytes', async () => {
    const nativeSource = { size: 3, writtenAt: 3, readAll: () => Buffer.from('abc'), dispose: () => undefined };
    const req = { ...request, initial: Buffer.from('\x1b[?2004h'), nativeSource,
      geometry: { start: { cols: 40, rows: 24 }, changes: [{ offset: 1, cols: 80, rows: 24 }] } };
    native.mockResolvedValue({ ok: false, reason: 'budget' });
    const reference = vi.fn(async (r: SnapshotRequest) => {
      expect(r.nativeSource).toBeUndefined(); expect(r.initial.toString()).toBe('\x1b[?2004habc');
      expect(r.geometry?.changes[0].offset).toBe(9);
      return success;
    });
    await selectAnsiSnapshot(req, reference);
    expect(native.mock.calls[0][0]).toMatchObject({ nativeSource: undefined, initial: Buffer.from('\x1b[?2004habc') });
    expect(reference).toHaveBeenCalledOnce();
  });
});
