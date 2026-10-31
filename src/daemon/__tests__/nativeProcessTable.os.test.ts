import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The native process table (Windows) in ProcessMonitor and the agent tracker,
// with the native module and child_process stubbed: which path serves each
// read, the failure latch, the kill switch, PID reuse, and the cadence.
const native = vi.hoisted(() => ({ processTable: vi.fn(), load: vi.fn() }));
const spawn = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock('../../shared/nativeTerminalCore', () => ({
  loadNativeTerminalCore: native.load,
  reportNativeFallback: vi.fn(),
}));
vi.mock('child_process', () => ({ execFile: spawn.execFile }));

type Row = { pid: number; ppid: number; name: string; created?: number; cmdline?: string };
const realPlatform = process.platform;

function tasklistAnswers(stdout: string): void {
  spawn.execFile.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
    cb(null, { stdout, stderr: '' });
  });
}

async function load() {
  vi.resetModules();
  const { ProcessMonitor } = await import('../ProcessMonitor');
  const tracker = await import('../AgentProcessTracker');
  return { ProcessMonitor, tracker };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  native.processTable.mockReset();
  native.load.mockReset().mockImplementation(() => ({ processTable: native.processTable }));
  spawn.execFile.mockReset();
  tasklistAnswers('');
  delete process.env.WMUX_NATIVE_PROCESS_TABLE;
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
  vi.useRealTimers();
});

describe('ProcessMonitor on the native process table', () => {
  it('serves the batch from one snapshot without spawning tasklist', async () => {
    const { ProcessMonitor } = await load();
    native.processTable.mockResolvedValue([
      { pid: 10, ppid: 1, name: 'pwsh.exe' },
      { pid: 11, ppid: 1, name: 'node.exe' },
    ] satisfies Row[]);
    const { alive, images } = await ProcessMonitor.batchCheckAliveDetailed([10, 12]);
    expect([...alive]).toEqual([10]);
    expect(images.get(10)).toBe('pwsh.exe');
    expect(native.load).toHaveBeenCalledWith('process-table-v1');
    expect(native.processTable).toHaveBeenCalledWith(false);
    expect(spawn.execFile).not.toHaveBeenCalled();
  });

  it('skips the sweep on a failed read, and moves to tasklist after three in a row', async () => {
    const { ProcessMonitor } = await load();
    tasklistAnswers('"pwsh.exe","10","Console","1","95,000 K"\n');
    native.processTable.mockRejectedValueOnce(new Error('snapshot failed'));
    await expect(ProcessMonitor.batchCheckAliveDetailed([10])).rejects.toThrow();
    expect(spawn.execFile).not.toHaveBeenCalled();

    native.processTable.mockResolvedValueOnce([{ pid: 10, ppid: 1, name: 'pwsh.exe' }]);
    await ProcessMonitor.batchCheckAliveDetailed([10]); // a success resets the count

    native.processTable.mockRejectedValue(new Error('snapshot failed'));
    for (let i = 0; i < 2; i++) await expect(ProcessMonitor.batchCheckAliveDetailed([10])).rejects.toThrow();
    expect(spawn.execFile).not.toHaveBeenCalled();
    // The third in a row latches native off; that read and later ones use tasklist.
    expect([...(await ProcessMonitor.batchCheckAliveDetailed([10])).alive]).toEqual([10]);
    await ProcessMonitor.batchCheckAliveDetailed([10]);
    expect(native.processTable).toHaveBeenCalledTimes(5);
    expect(spawn.execFile).toHaveBeenCalledTimes(2);
  });

  it('loads the module once', async () => {
    const { ProcessMonitor } = await load();
    native.processTable.mockResolvedValue([]);
    for (let i = 0; i < 3; i++) await ProcessMonitor.batchCheckAliveDetailed([10]);
    expect(native.load).toHaveBeenCalledTimes(1);
  });

  it('falls back when the module lacks the capability', async () => {
    const { ProcessMonitor } = await load();
    native.load.mockImplementation(() => { throw new Error('Native terminal core lacks process-table-v1'); });
    tasklistAnswers('"pwsh.exe","10","Console","1","95,000 K"\n');
    expect([...(await ProcessMonitor.batchCheckAliveDetailed([10])).alive]).toEqual([10]);
    expect(spawn.execFile).toHaveBeenCalledTimes(1);
  });

  it('WMUX_NATIVE_PROCESS_TABLE=off keeps the spawn path', async () => {
    process.env.WMUX_NATIVE_PROCESS_TABLE = 'off';
    const { ProcessMonitor } = await load();
    await ProcessMonitor.batchCheckAliveDetailed([10]);
    expect(native.load).not.toHaveBeenCalled();
    expect(spawn.execFile).toHaveBeenCalledTimes(1);
  });

  it('a confirmation probe that fails natively is "unknown", never "dead"', async () => {
    const { ProcessMonitor } = await load();
    native.processTable.mockRejectedValue(new Error('snapshot failed'));
    await expect(ProcessMonitor.isDefinitelyDead(10)).rejects.toThrow('Native process table read failed');
    expect(spawn.execFile).not.toHaveBeenCalled();
    await expect(ProcessMonitor.isDefinitelyDead(10)).rejects.toThrow('Native process table read failed');
    // The third failure in a row latches native off: a failing tasklist probe is still unknown.
    spawn.execFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb: (e: Error | null) => void) => cb(new Error('timeout')));
    await expect(ProcessMonitor.isDefinitelyDead(10)).rejects.toThrow('timeout');
  });

  it('reads a reused PID (same pid, different image) as dead, confirmed by a second snapshot', async () => {
    const { ProcessMonitor } = await load();
    let image = 'pwsh.exe';
    native.processTable.mockImplementation(async () => [{ pid: 100, ppid: 1, name: image }]);
    const onDead = vi.fn();
    const monitor = new ProcessMonitor(60_000, 60_000);
    monitor.watch('s', 100, onDead); // binds pwsh.exe
    await settle();
    expect(onDead).not.toHaveBeenCalled();

    image = 'chrome.exe';
    const before = native.processTable.mock.calls.length;
    (monitor as unknown as { runBatchCheck(): void }).runBatchCheck();
    await settle();
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(native.processTable.mock.calls.length - before).toBe(2); // batch + re-probe
    expect(spawn.execFile).not.toHaveBeenCalled();
    monitor.unwatchAll();
  });

  it('reads liveness only from the walk (no details), so a pid missing from the detailed join stays alive', async () => {
    const { ProcessMonitor } = await load();
    // The detailed (joined) table has lost pid 100; the walk still lists it.
    native.processTable.mockImplementation(async (details: boolean) =>
      details ? [] : [{ pid: 100, ppid: 1, name: 'pwsh.exe' }]);
    const onDead = vi.fn();
    const monitor = new ProcessMonitor(60_000, 60_000);
    monitor.watch('s', 100, onDead);
    await settle();
    for (let i = 0; i < 3; i++) {
      (monitor as unknown as { runBatchCheck(): void }).runBatchCheck();
      await settle();
    }
    expect(await ProcessMonitor.isDefinitelyDead(100)).toBe(false);
    expect(onDead).not.toHaveBeenCalled();
    expect(native.processTable.mock.calls.every(([details]) => details === false)).toBe(true);
    monitor.unwatchAll();
  });

  it('confirms a death with a second snapshot', async () => {
    const { ProcessMonitor } = await load();
    let rows: Row[] = [{ pid: 100, ppid: 1, name: 'pwsh.exe' }];
    native.processTable.mockImplementation(async () => rows);
    const onDead = vi.fn();
    const monitor = new ProcessMonitor(60_000, 60_000);
    monitor.watch('s', 100, onDead);
    await settle();
    rows = [];
    const before = native.processTable.mock.calls.length;
    (monitor as unknown as { runBatchCheck(): void }).runBatchCheck();
    await settle();
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(native.processTable.mock.calls.length - before).toBe(2);
    monitor.unwatchAll();
  });

  it('sweeps at the native cadence, and at the spawn cadence once native fails', async () => {
    vi.useFakeTimers();
    const { ProcessMonitor } = await load();
    native.processTable.mockResolvedValue([{ pid: 100, ppid: 1, name: 'pwsh.exe' }]);
    const monitor = new ProcessMonitor(15_000, 3_000);
    monitor.watch('s', 100, vi.fn());
    await vi.advanceTimersByTimeAsync(9_000);
    expect(native.processTable).toHaveBeenCalledTimes(4); // immediate + 3 ticks

    native.processTable.mockRejectedValue(new Error('snapshot failed'));
    tasklistAnswers('"pwsh.exe","100","Console","1","95,000 K"\n');
    await vi.advanceTimersByTimeAsync(9_000); // three failed ticks latch tasklist; cadence resets
    const spawned = spawn.execFile.mock.calls.length;
    await vi.advanceTimersByTimeAsync(14_000);
    expect(spawn.execFile.mock.calls.length).toBe(spawned);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawn.execFile.mock.calls.length).toBe(spawned + 1);
    monitor.unwatchAll();
  });

  it('keeps the spawn cadence off Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.useFakeTimers();
    const { ProcessMonitor } = await load();
    const batch = vi.spyOn(ProcessMonitor, 'batchCheckAliveDetailed').mockResolvedValue({ alive: new Set([100]), images: new Map() });
    const monitor = new ProcessMonitor(15_000, 3_000);
    monitor.watch('s', 100, vi.fn());
    await vi.advanceTimersByTimeAsync(14_000);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(native.load).not.toHaveBeenCalled();
    monitor.unwatchAll();
  });
});

describe('agent tracker rows from the native table', () => {
  it('maps rows to the CIM parser shape: unreadable fields are absent', async () => {
    const { tracker } = await load();
    expect(tracker.fromNativeRow({ pid: 5, ppid: 4, name: 'claude.exe', created: 1_700_000_000_000, cmdline: 'claude --resume x' }))
      .toEqual(tracker.parsePipeDelimited('5|4|1700000000000|claude.exe|claude --resume x')[0]);
    expect(tracker.fromNativeRow({ pid: 4, ppid: 0, name: 'System', created: null, cmdline: null }))
      .toEqual(tracker.parsePipeDelimited('4|0||System|')[0]);
  });
});
