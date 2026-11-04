import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetEngineControllerForTests, createEngineController, decideEngine, settleStartupEngine, type EngineControllerDeps, type TerminalEngine } from '../engineController';
import { preloadWongtty } from '../load';

const store = vi.hoisted(() => ({
  state: { terminalWongtty: false, terminalEngine: 'xterm' as 'xterm' | 'wongtty', setTerminalEngine: (e: 'xterm' | 'wongtty') => { store.state.terminalEngine = e; }, setTerminalEngineFailure: () => undefined, pushToast: () => '' },
}));
vi.mock('../../../stores', () => ({ useStore: { getState: () => store.state, subscribe: () => () => undefined } }));
vi.mock('../../../i18n', () => ({ t: (key: string) => key }));
vi.mock('../load', () => ({ preloadWongtty: vi.fn(() => new Promise(() => undefined)), wongttyLoadFailure: vi.fn() }));

/** A controllable world: the switch, the engine it writes, and a load whose
 *  answer each test hands out by hand. */
function world() {
  let requested = false;
  let engine: TerminalEngine = 'xterm';
  let listener: ((r: boolean) => void) | null = null;
  const loads: Array<(mod: unknown) => void> = [];
  const writes: TerminalEngine[] = [];
  const failures: Array<{ message: string } | null> = [];
  const report = vi.fn<(message: string) => void>();
  let failureText: string | null = null;
  const deps: EngineControllerDeps = {
    getRequested: () => requested,
    subscribeRequested: (l) => { listener = l; return () => { listener = null; }; },
    getEngine: () => engine,
    setEngine: (e) => { engine = e; writes.push(e); },
    setFailure: (f) => failures.push(f),
    load: () => new Promise((resolve) => loads.push(resolve)),
    loadFailure: () => failureText,
    report,
  };
  return {
    deps,
    report,
    writes,
    failures,
    loads,
    engine: () => engine,
    toggle(on: boolean) { requested = on; listener?.(on); },
    failText(text: string) { failureText = text; },
  };
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('decideEngine', () => {
  it('is xterm when off, waits for a pending load, and follows its result', () => {
    expect(decideEngine(false, 'loaded')).toBe('xterm');
    expect(decideEngine(true, 'pending')).toBe('wait');
    expect(decideEngine(true, 'loaded')).toBe('wongtty');
    expect(decideEngine(true, 'failed')).toBe('xterm');
  });
});

describe('engine controller', () => {
  it('switches off to on once wongtty has loaded, after the quiet window', async () => {
    const w = world();
    const c = createEngineController(w.deps);
    await c.settleStartup(5000);
    w.toggle(true);
    expect(w.loads).toHaveLength(0);
    vi.advanceTimersByTime(150);
    expect(w.loads).toHaveLength(1);
    expect(w.engine()).toBe('xterm');
    w.loads[0]({});
    await flush();
    expect(w.writes).toEqual(['wongtty']);
  });

  it('on/off/on within a second while the load is pending writes wongtty exactly once, and never after a later off', async () => {
    const w = world();
    const c = createEngineController(w.deps);
    await c.settleStartup(5000);
    w.toggle(true);
    vi.advanceTimersByTime(200); // load 1 starts
    w.toggle(false);
    vi.advanceTimersByTime(200); // off decided: xterm, load 1 now stale
    w.toggle(true);
    vi.advanceTimersByTime(200); // load 2 starts
    expect(w.loads).toHaveLength(2);
    w.loads[0]({}); // the stale load finishes first
    await flush();
    expect(w.writes).toEqual([]);
    w.loads[1]({});
    await flush();
    expect(w.writes).toEqual(['wongtty']);
    w.toggle(false);
    vi.advanceTimersByTime(150);
    expect(w.writes).toEqual(['wongtty', 'xterm']);
    // A third load that finishes after the off changes nothing.
    w.toggle(true);
    vi.advanceTimersByTime(10);
    w.toggle(false);
    vi.advanceTimersByTime(150);
    w.loads.forEach((resolve) => resolve({}));
    await flush();
    expect(w.writes).toEqual(['wongtty', 'xterm']);
  });

  it('on then off before the load finishes stays xterm', async () => {
    const w = world();
    const c = createEngineController(w.deps);
    await c.settleStartup(5000);
    w.toggle(true);
    vi.advanceTimersByTime(150);
    w.toggle(false);
    vi.advanceTimersByTime(150);
    w.loads[0]({});
    await flush();
    expect(w.engine()).toBe('xterm');
    expect(w.writes).toEqual([]);
  });

  it('a failed load stays xterm, is reported once, and the next on retries', async () => {
    const w = world();
    const c = createEngineController(w.deps);
    await c.settleStartup(5000);
    w.failText('wasm compile failed');
    w.toggle(true);
    vi.advanceTimersByTime(150);
    w.loads[0](null);
    await flush();
    expect(w.engine()).toBe('xterm');
    expect(w.report).toHaveBeenCalledTimes(1);
    expect(w.failures.at(-1)).toEqual({ message: 'wasm compile failed' });
    // Off clears the error; on retries (and the same message is not toasted again).
    w.toggle(false);
    vi.advanceTimersByTime(150);
    expect(w.failures.at(-1)).toBeNull();
    w.toggle(true);
    vi.advanceTimersByTime(150);
    expect(w.loads).toHaveLength(2);
    w.loads[1](null);
    await flush();
    expect(w.report).toHaveBeenCalledTimes(1);
    w.toggle(false);
    vi.advanceTimersByTime(150);
    w.toggle(true);
    vi.advanceTimersByTime(150);
    w.loads[2]({});
    await flush();
    expect(w.engine()).toBe('wongtty');
    expect(w.failures.at(-1)).toBeNull();
  });

  it('a pane that cannot be built sends every pane back to xterm, reported once', async () => {
    const w = world();
    const c = createEngineController(w.deps);
    await c.settleStartup(5000);
    w.toggle(true);
    vi.advanceTimersByTime(150);
    w.loads[0]({});
    await flush();
    expect(w.engine()).toBe('wongtty');
    c.fail(new Error('no WebGL2'));
    c.fail(new Error('no WebGL2'));
    expect(w.engine()).toBe('xterm');
    expect(w.report).toHaveBeenCalledTimes(1);
    expect(w.failures.at(-1)).toEqual({ message: 'no WebGL2' });
  });

  it('acts at once during startup, and settleStartup waits for the load', async () => {
    const w = world();
    const c = createEngineController(w.deps);
    w.toggle(true); // loadSession
    expect(w.loads).toHaveLength(1);
    let settled: boolean | null = null;
    void c.settleStartup(5000).then((s) => { settled = s; });
    await flush();
    expect(settled).toBeNull();
    w.loads[0]({});
    await flush();
    expect(settled).toBe(true);
    expect(w.writes).toEqual(['wongtty']);
  });

  it('settleStartup returns at once with the switch off, and false after its timeout', async () => {
    const off = world();
    await expect(createEngineController(off.deps).settleStartup(5000)).resolves.toBe(true);
    const slow = world();
    const c = createEngineController(slow.deps);
    slow.toggle(true);
    const result = c.settleStartup(5000);
    vi.advanceTimersByTime(5000);
    await expect(result).resolves.toBe(false);
    slow.loads[0]({});
    await flush();
    expect(slow.engine()).toBe('wongtty');
  });
});

describe('settleStartupEngine (AppLayout, before the pane gate opens)', () => {
  afterEach(() => { __resetEngineControllerForTests(); vi.mocked(preloadWongtty).mockClear(); });

  it('returns at once with the switch off, loading nothing', async () => {
    store.state.terminalWongtty = false;
    await settleStartupEngine({ timeoutMs: 5000 });
    expect(preloadWongtty).not.toHaveBeenCalled();
  });

  it('gives up after its timeout with the load still pending, so panes start as xterm.js', async () => {
    store.state.terminalWongtty = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const settled = settleStartupEngine({ timeoutMs: 5000 });
    vi.advanceTimersByTime(5000);
    await settled;
    expect(preloadWongtty).toHaveBeenCalledTimes(1);
    expect(store.state.terminalEngine).toBe('xterm');
    expect(warn.mock.calls.some(([m]) => String(m).includes('startup-late'))).toBe(true);
    warn.mockRestore();
  });
});
