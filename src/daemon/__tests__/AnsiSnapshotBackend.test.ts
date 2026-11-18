import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAnsiSnapshotBackendDiagnostics, selectAnsiSnapshot } from '../AnsiSnapshotBackend';
import type { SnapshotOutcome, SnapshotRequest } from '../HeadlessSnapshot';
import { generateRustSnapshot } from '../RustSnapshot';
import { NATIVE_SNAPSHOT_MAX_INPUT_BYTES } from '../nativeSnapshotLimits';
import { NATIVE_CIRCUIT_COOLDOWNS_MS } from '../nativeCircuit';
vi.mock('../RustSnapshot', () => ({ generateRustSnapshot: vi.fn() }));
const native = vi.mocked(generateRustSnapshot);
const request = { cols: 80, rows: 24, initial: Buffer.from('hello'), budgetMs: 1000 };
const success = { ok: true as const, payload: Buffer.from('hello'), bytesIn: 5, durationMs: 1 };
let moduleId = 0;
beforeEach(() => {
  // CI names the built core in WMUX_TERMINAL_CORE_MODULE, which nativeCorePath reads first: unset it here so the stub is the module.
  vi.stubEnv('WMUX_TERMINAL_CORE_MODULE', undefined);
  vi.stubEnv('WMUX_RUST_SNAPSHOT', 'ansi');
  vi.stubEnv('WMUX_RUST_SNAPSHOT_MODULE', `/test/native-${++moduleId}.cjs`);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetAllMocks(); });
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

  // The Node engine is removed: WMUX_TERMINAL_CORE no longer selects anything.
  it.each(['rust', 'node', undefined])('reads the removed shadow mode as unset: Rust, with WMUX_TERMINAL_CORE=%s', async (engine) => {
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'shadow');
    vi.stubEnv('WMUX_TERMINAL_CORE', engine);
    nativeSuccess(request.initial);
    const reference = vi.fn(async () => success);
    expect(await selectAnsiSnapshot(request, reference)).toMatchObject({ ...success, durationMs: expect.any(Number) });
    expect(reference).not.toHaveBeenCalled();
  });

  it.each(['rust', 'node'])('keeps xterm with mode off, with WMUX_TERMINAL_CORE=%s', async (engine) => {
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'off');
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

  // R2 (b) prep: native is the delivering path, so it gets the caller's whole budget.
  it('hands native the whole budget, and the fallback what a refusal leaves of it', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    native.mockImplementationOnce(async () => { now = 700; return { ok: false, reason: 'error', detail: 'unsupported-wide-edge' }; });
    const reference = vi.fn(async (_req: SnapshotRequest) => success);
    await selectAnsiSnapshot(request, reference);
    expect(native.mock.calls[0][0].budgetMs).toBe(1000);
    expect(reference.mock.calls[0][0].budgetMs).toBe(300);
  });

  it('ends with budget, without xterm, when native spent the whole budget', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    native.mockImplementationOnce(async () => { now = 1001; return { ok: false, reason: 'budget' }; });
    const reference = vi.fn(async () => success);
    const before = getAnsiSnapshotBackendDiagnostics();
    expect(await selectAnsiSnapshot(request, reference)).toMatchObject({ ok: false, reason: 'budget' });
    expect(reference).not.toHaveBeenCalled();
    // Native's own outcome, not an xterm fallback that never ran.
    const after = getAnsiSnapshotBackendDiagnostics();
    expect(after.fallbacks).toBe(before.fallbacks);
    expect(after.reasons.budget).toBe((before.reasons.budget ?? 0) + 1);
    expect(after.last).toEqual({ backend: 'rust', reason: 'budget' });
  });

  it('delivers a complete native snapshot whose serialization ended just past the deadline', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    native.mockImplementationOnce((async () => { now = 1040; return success; }) as never);
    const reference = vi.fn(async () => success);
    expect(await selectAnsiSnapshot(request, reference)).toMatchObject({ ok: true, durationMs: 1040 });
    expect(reference).not.toHaveBeenCalled();
    expect(getAnsiSnapshotBackendDiagnostics().last).toEqual({ backend: 'rust', reason: 'native' });
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

  // R2 (b) prep: the circuit no longer stays open for the life of the daemon (nativeCircuit.ts).
  it('lets one trial through after the cooldown, and closes the circuit when the module works', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    native.mockRejectedValueOnce(new Error('load failed'));
    const reference = vi.fn(async () => success);
    await selectAnsiSnapshot(request, reference);
    now = NATIVE_CIRCUIT_COOLDOWNS_MS[0] - 1;
    await selectAnsiSnapshot(request, reference);
    expect(native).toHaveBeenCalledOnce();
    now = NATIVE_CIRCUIT_COOLDOWNS_MS[0];
    nativeSuccess(request.initial);
    expect(await selectAnsiSnapshot(request, reference)).toMatchObject({ ok: true });
    expect(native).toHaveBeenCalledTimes(2);
    expect(getAnsiSnapshotBackendDiagnostics()).toMatchObject({ circuitOpen: false, last: { backend: 'rust', reason: 'native' } });
  });

  it('reopens a failed trial for the next cooldown, and skips everything while the trial runs', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    native.mockRejectedValueOnce(new Error('load failed'));
    const reference = vi.fn(async () => success);
    await selectAnsiSnapshot(request, reference);
    now = NATIVE_CIRCUIT_COOLDOWNS_MS[0];
    let failTrial!: (err: Error) => void;
    native.mockImplementationOnce(() => new Promise((_resolve, reject) => { failTrial = reject; }));
    const trial = selectAnsiSnapshot(request, reference);
    // A second request while the trial is out: skipped, the trial is not doubled.
    await selectAnsiSnapshot(request, reference);
    expect(native).toHaveBeenCalledTimes(2);
    expect(getAnsiSnapshotBackendDiagnostics().last).toEqual({ backend: 'xterm', reason: 'circuit-open' });
    failTrial(new Error('still broken'));
    await trial;
    expect(getAnsiSnapshotBackendDiagnostics().circuitOpen).toBe(true);
    now = NATIVE_CIRCUIT_COOLDOWNS_MS[0] + NATIVE_CIRCUIT_COOLDOWNS_MS[1] - 1;
    await selectAnsiSnapshot(request, reference);
    expect(native).toHaveBeenCalledTimes(2);
  });

  it('closes the circuit on a trial that the module refuses: a refusal means it works', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    native.mockRejectedValueOnce(new Error('load failed'));
    const reference = vi.fn(async () => success);
    await selectAnsiSnapshot(request, reference);
    now = NATIVE_CIRCUIT_COOLDOWNS_MS[0];
    native.mockResolvedValueOnce({ ok: false, reason: 'error', detail: 'unsupported-wide-edge' });
    await selectAnsiSnapshot(request, reference);
    expect(getAnsiSnapshotBackendDiagnostics().circuitOpen).toBe(false);
  });

  it('takes an attach request: a full ring with its preamble and 100k rows of scrollback', async () => {
    const initial = Buffer.alloc(8 * 1024 * 1024 + 64, 0x61);
    nativeSuccess(initial);
    const reference = vi.fn();
    await selectAnsiSnapshot({ ...request, initial, scrollback: 100000 }, reference);
    expect(native).toHaveBeenCalledOnce(); expect(reference).not.toHaveBeenCalled();
  });

  it('takes a ring above the old 8 MiB cap: any ring the daemon allows', async () => {
    const initial = Buffer.alloc(16 * 1024 * 1024, 0x61);
    nativeSuccess(initial);
    const reference = vi.fn();
    await selectAnsiSnapshot({ ...request, initial }, reference);
    expect(native).toHaveBeenCalledOnce(); expect(reference).not.toHaveBeenCalled();
  });

  it.each([
    // Only its length is read before the skip: a ring above the daemon's largest.
    ['an oversized input', { initial: { length: NATIVE_SNAPSHOT_MAX_INPUT_BYTES + 1 } as Buffer }],
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

  // R2 (b) prep 4: the refusal rates. Each native try by its outcome, counted when it settles.
  it('counts each native try by its outcome, and nothing for a skip', async () => {
    const before = getAnsiSnapshotBackendDiagnostics().tried;
    const delta = () => {
      const now = getAnsiSnapshotBackendDiagnostics().tried;
      return Object.fromEntries(Object.entries(now).map(([k, n]) => [k, n - (before[k] ?? 0)]).filter(([, n]) => n));
    };
    const reference = vi.fn(async () => success);
    nativeSuccess(request.initial);
    await selectAnsiSnapshot(request, reference);
    native.mockResolvedValueOnce({ ok: false, reason: 'error', detail: 'unsupported-wide-edge' });
    await selectAnsiSnapshot(request, reference);
    // Limits and an open circuit are skips: native never ran.
    await selectAnsiSnapshot({ ...request, scrollback: 100001 }, reference);
    native.mockRejectedValueOnce(new Error('load failed'));
    await selectAnsiSnapshot(request, reference);
    await selectAnsiSnapshot(request, reference);
    expect(delta()).toEqual({ native: 1, 'unsupported-wide-edge': 1, error: 1 });
    expect(getAnsiSnapshotBackendDiagnostics()).toMatchObject({ circuitOpen: true, circuitFailures: 1 });
  });

  // `wmux doctor` shows these, so the next native gap is picked by how often
  // real panes hit it.
  it('counts each fallback and skip by reason, a native refusal by its family', async () => {
    const before = getAnsiSnapshotBackendDiagnostics().reasons;
    const delta = () => {
      const now = getAnsiSnapshotBackendDiagnostics().reasons;
      return Object.fromEntries(Object.entries(now).map(([k, n]) => [k, n - (before[k] ?? 0)]).filter(([, n]) => n));
    };
    const reference = vi.fn(async () => success);
    native.mockResolvedValueOnce({ ok: false, reason: 'error', detail: 'unsupported-state: a control Alacritty parses differently' });
    await selectAnsiSnapshot(request, reference);
    // The native refusal names the control that sent the pane to xterm.
    native.mockResolvedValueOnce({ ok: false, reason: 'error', detail: 'unsupported-state-charset: a national character set' });
    await selectAnsiSnapshot(request, reference);
    expect(getAnsiSnapshotBackendDiagnostics().last).toEqual({ backend: 'xterm', reason: 'state' });
    native.mockResolvedValueOnce({ ok: false, reason: 'error', detail: 'unsupported-history-limit: history reached the native grid cap' });
    await selectAnsiSnapshot(request, reference);
    native.mockResolvedValueOnce({ ok: false, reason: 'error', detail: 'unsupported-history-limit: history reached the native grid cap' });
    await selectAnsiSnapshot(request, reference);
    native.mockResolvedValueOnce({ ok: false, reason: 'margins' });
    await selectAnsiSnapshot(request, reference);
    native.mockResolvedValueOnce({ ok: false, reason: 'budget' });
    await selectAnsiSnapshot(request, reference);
    await selectAnsiSnapshot({ ...request, scrollback: 100001 }, reference);
    expect(delta()).toEqual({ 'unsupported-state': 1, 'unsupported-state-charset': 1, 'unsupported-history-limit': 2, margins: 1, budget: 1, limits: 1 });
    expect(getAnsiSnapshotBackendDiagnostics().circuitOpen).toBe(false);
  });

  // A refusal hides what else the stream holds; `reasonsSeen` counts every
  // family a refused stream met, once per snapshot, the counted one included.
  it('counts every refusal family a refused stream holds in reasonsSeen', async () => {
    const before = getAnsiSnapshotBackendDiagnostics();
    const delta = (key: 'reasons' | 'reasonsSeen') => {
      const now = getAnsiSnapshotBackendDiagnostics()[key];
      return Object.fromEntries(Object.entries(now).map(([k, n]) => [k, n - (before[key][k] ?? 0)]).filter(([, n]) => n));
    };
    const reference = vi.fn(async () => success);
    native.mockResolvedValueOnce({
      ok: false, reason: 'error', detail: 'unsupported-state-mode: a mode Alacritty sets differently',
      families: ['unsupported-state-mode', 'unsupported-state-charset', 'unsupported-state-mode'],
    } as never);
    await selectAnsiSnapshot(request, reference);
    // A module built before families: the counted family only.
    native.mockResolvedValueOnce({ ok: false, reason: 'error', detail: 'unsupported-state-sgr: an SGR attribute' });
    await selectAnsiSnapshot(request, reference);
    // Not a native refusal: nothing seen.
    native.mockResolvedValueOnce({ ok: false, reason: 'budget' });
    await selectAnsiSnapshot(request, reference);
    expect(delta('reasons')).toEqual({ 'unsupported-state-mode': 1, 'unsupported-state-sgr': 1, budget: 1 });
    expect(delta('reasonsSeen')).toEqual({ 'unsupported-state-mode': 1, 'unsupported-state-charset': 1, 'unsupported-state-sgr': 1 });
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
