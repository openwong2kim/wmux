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

  it.each([
    ['OSC title', '\x1b]0;✳ Claude Code\x07ready'],
    ['OSC query', '\x1b]11;?\x07ready'],
    ['OSC 8 hyperlink', '\x1b]8;;https://example.com\x07link\x1b]8;;\x07'],
    ['DECSC/DECRC', '\x1b7\x1b[r\x1b8saved'],
    ['SCOSC/SCORC', '\x1b[sx\x1b[u'],
    ['kitty keyboard', '\x1b[>1u\x1b[?u\x1b[<u'],
    ['HTS', '\x1bH\tx'],
    ['TBC', '\x1b[3g\x1b[g'],
    ['DECSCUSR', '\x1b[5 q'],
    ['XTVERSION', '\x1b[>0q'],
    ['DECSCA', '\x1b[1"q'],
    ['SO/SI', '\x0ex\x0f'],
    ['ASCII designation', '\x1b(B\x1b)B\x1b[m'],
    ['SGR 55', '\x1b[55mx'],
    ['blink', '\x1b[5mblink'],
    ['color operand 53', '\x1b[38;5;53mcolor'],
    ['RGB operands 53/55', '\x1b[48;2;53;55;6mcolor'],
    ['colon RGB operands', '\x1b[38:2::53:55:5mcolor'],
  ])('replays %s on Rust', async (_name, text) => {
    const initial = Buffer.from(text);
    nativeSuccess(initial);
    const reference = vi.fn();
    await selectAnsiSnapshot({ ...request, initial }, reference);
    expect(native).toHaveBeenCalledOnce(); expect(reference).not.toHaveBeenCalled();
  });

  it.each([
    ['DEC graphics', '\x1b(0lqk\x1b(B'],
    ['G1 DEC graphics', '\x1b)0\x0eq\x0f'],
    ['national set', '\x1b(A#'],
    ['G2 designation', '\x1b*0'],
    ['C1 CSI', 'a\u009b31m'],
    ['overline', '\x1b[53moverline'],
    ['SGR 21', '\x1b[21mx'],
    ['overline after RGB', '\x1b[38;2;1;2;3;53moverline'],
    ['malformed color', '\x1b[38;2;53mbad color'],
    ['DECSED', '\x1b[?2J'],
    ['DECSEL', '\x1b[?K'],
    ['SL', '\x1b[2 @'],
    ['DECIC', '\x1b[2\'}'],
    ['DECSTR', '\x1b[!p'],
    ['SU', '\x1b[2S'],
    ['ED 2 spelled 0;2', '\x1b[2;0J'],
    ['LNM', '\x1b[20h'],
    ['X10 mouse', '\x1b[?9h'],
    ['reverse wrap', '\x1b[?1;45h'],
    ['DECNKM', '\x1b[?66h'],
    ['alt 1047', '\x1b[?1047l'],
    ['cursor save 1048', '\x1b[?1048h'],
  ])('retains xterm for %s', async (_name, text) => {
    const reference = vi.fn(async () => success);
    await selectAnsiSnapshot({ ...request, initial: Buffer.from(text) }, reference);
    expect(native).not.toHaveBeenCalled(); expect(reference).toHaveBeenCalledOnce();
    expect(getAnsiSnapshotBackendDiagnostics().last).toEqual({ backend: 'xterm', reason: 'state' });
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

  it('falls back when drained bytes carry divergent state, even split from the history', async () => {
    const initial = Buffer.from('hello\x1b(');
    const queue = [[Buffer.from('0q')], []];
    native.mockImplementation(drainAll);
    const seen: string[] = [];
    const reference = vi.fn(async (req: SnapshotRequest): Promise<SnapshotOutcome> => {
      seen.push(...req.drainQueue!().map(String)); return success;
    });
    await selectAnsiSnapshot({ ...request, initial, drainQueue: () => queue.shift() ?? [] }, reference);
    expect(reference).toHaveBeenCalledOnce(); expect(seen).toEqual(['0q']);
    expect(getAnsiSnapshotBackendDiagnostics().last).toEqual({ backend: 'xterm', reason: 'state' });
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
