import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// PortWatcher's macOS/Linux snapshot with the native module, child_process
// and the file system stubbed: which path serves each tick, the failure and
// timeout latch, the kill switch, and the in-process tool lookup (no PATH
// walk by the spawn).
const native = vi.hoisted(() => ({ portSnapshot: vi.fn(), load: vi.fn() }));
const spawn = vi.hoisted(() => ({ execFile: vi.fn() }));
const files = vi.hoisted(() => ({ present: new Set<string>(), checked: [] as string[] }));

vi.mock('../../../shared/nativeTerminalCore', () => ({
  loadNativeTerminalCore: native.load,
  reportNativeFallback: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFile: spawn.execFile }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const accessSync = (p: string) => {
    files.checked.push(p);
    if (!files.present.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  const statSync = () => ({ isFile: () => true });
  return { ...real, default: { ...real, accessSync, statSync }, accessSync, statSync };
});

const realPlatform = process.platform;
const realPath = process.env.PATH;
const LSOF_OUT = 'p200\nn127.0.0.1:5173\n';

function spawnAnswers(out: Record<string, string>): void {
  spawn.execFile.mockImplementation((file: string, _args: string[], _opts: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
    cb(null, { stdout: out[file] ?? '', stderr: '' });
  });
}

async function load() {
  vi.resetModules();
  return import('../portWatch');
}

beforeEach(() => {
  native.portSnapshot.mockReset().mockResolvedValue({
    processes: [{ pid: 200, ppid: 100, name: 'node' }],
    sockets: [
      { pid: 200, port: 3000, address: '127.0.0.1', family: 4 },
      { pid: 200, port: 3000, address: '::1', family: 6 },
    ],
  });
  native.load.mockReset().mockImplementation(() => ({ portSnapshot: native.portSnapshot }));
  spawn.execFile.mockReset();
  files.present = new Set(['/bin/ps', '/usr/sbin/lsof']);
  files.checked = [];
  spawnAnswers({ '/bin/ps': '  200   100\n  100     1\n', '/usr/sbin/lsof': LSOF_OUT });
  process.env.PATH = '/usr/local/bin:/usr/bin:/bin';
  delete process.env.WMUX_NATIVE_PROCESS_TABLE;
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  process.env.PATH = realPath;
  vi.useRealTimers();
});

describe.each(['darwin', 'linux'] as const)('PortWatcher snapshot on %s', (platform) => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  });

  it('reads the walk and the sockets in one native call, without spawning', async () => {
    const { defaultSnapshot } = await load();
    const snap = await defaultSnapshot();
    expect([...snap.ppidByPid]).toEqual([[200, 100]]);
    expect(snap.listeners).toEqual([{ port: 3000, pid: 200 }, { port: 3000, pid: 200 }]);
    expect(native.load).toHaveBeenCalledWith('listen-sockets-v1');
    expect(native.portSnapshot).toHaveBeenCalledTimes(1);
    expect(spawn.execFile).not.toHaveBeenCalled();
  });

  it('sends a failed native tick to ps and lsof by absolute path, and latches after three in a row', async () => {
    const { defaultSnapshot } = await load();
    native.portSnapshot.mockRejectedValue(new Error('read failed'));
    for (let i = 0; i < 4; i++) {
      const snap = await defaultSnapshot();
      expect(snap.ppidByPid.get(200)).toBe(100);
      expect(snap.listeners).toEqual([{ port: 5173, pid: 200 }]);
    }
    expect(native.portSnapshot).toHaveBeenCalledTimes(3);
    expect(new Set(spawn.execFile.mock.calls.map((c) => c[0]))).toEqual(new Set(['/bin/ps', '/usr/sbin/lsof']));
  });

  it('a native call that never returns times out into ps and lsof, and counts toward the latch', async () => {
    vi.useFakeTimers();
    const { defaultSnapshot, NATIVE_SNAPSHOT_TIMEOUT_MS } = await load();
    // Never settles.
    native.portSnapshot.mockReturnValue(new Promise(vi.fn()));
    for (let i = 0; i < 4; i++) {
      const tick = defaultSnapshot();
      await vi.advanceTimersByTimeAsync(NATIVE_SNAPSHOT_TIMEOUT_MS);
      expect((await tick).listeners).toEqual([{ port: 5173, pid: 200 }]);
    }
    // Three hung calls latch it off: the fourth tick starts no new one.
    expect(native.portSnapshot).toHaveBeenCalledTimes(3);
  });

  it('a success resets the failure count', async () => {
    const { defaultSnapshot } = await load();
    native.portSnapshot.mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce(new Error('x'));
    for (let i = 0; i < 5; i++) await defaultSnapshot();
    native.portSnapshot.mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce(new Error('x'));
    for (let i = 0; i < 3; i++) await defaultSnapshot();
    // Never three failures in a row: native still serves.
    expect(native.portSnapshot).toHaveBeenCalledTimes(8);
  });

  it('uses ps and lsof when the module lacks the capability or the export', async () => {
    native.load.mockImplementation(() => { throw new Error('Native terminal core lacks listen-sockets-v1'); });
    let { defaultSnapshot } = await load();
    expect((await defaultSnapshot()).listeners).toEqual([{ port: 5173, pid: 200 }]);
    native.load.mockReset().mockImplementation(() => ({}));
    ({ defaultSnapshot } = await load());
    expect((await defaultSnapshot()).listeners).toEqual([{ port: 5173, pid: 200 }]);
    expect(native.portSnapshot).not.toHaveBeenCalled();
    expect(spawn.execFile).toHaveBeenCalledTimes(4);
  });

  it('WMUX_NATIVE_PROCESS_TABLE=off keeps ps and lsof', async () => {
    process.env.WMUX_NATIVE_PROCESS_TABLE = 'off';
    const { defaultSnapshot } = await load();
    await defaultSnapshot();
    expect(native.load).not.toHaveBeenCalled();
    expect(spawn.execFile).toHaveBeenCalledTimes(2);
  });

  it('finds a tool in PATH when it is in none of the usual places (NixOS, Guix)', async () => {
    process.env.WMUX_NATIVE_PROCESS_TABLE = 'off';
    process.env.PATH = 'relative/bin:/run/current-system/sw/bin/:/usr/bin';
    files.present = new Set(['/run/current-system/sw/bin/ps', '/run/current-system/sw/bin/lsof']);
    spawnAnswers({ '/run/current-system/sw/bin/ps': '  200   100\n', '/run/current-system/sw/bin/lsof': LSOF_OUT });
    const { defaultSnapshot } = await load();
    expect((await defaultSnapshot()).listeners).toEqual([{ port: 5173, pid: 200 }]);
    expect(spawn.execFile.mock.calls.map((c) => c[0])).toEqual(['/run/current-system/sw/bin/ps', '/run/current-system/sw/bin/lsof']);
    // A relative PATH entry is never tried.
    expect(files.checked.some((p) => !p.startsWith('/'))).toBe(false);
  });

  it('looks again after a miss, and keeps a hit', async () => {
    process.env.WMUX_NATIVE_PROCESS_TABLE = 'off';
    files.present = new Set(['/bin/ps']);
    const { defaultSnapshot } = await load();
    expect((await defaultSnapshot()).listeners).toEqual([]);
    expect(spawn.execFile.mock.calls.map((c) => c[0])).toEqual(['/bin/ps']);
    // lsof installed since: the next tick finds it.
    files.present = new Set(['/bin/ps', '/usr/sbin/lsof']);
    expect((await defaultSnapshot()).listeners).toEqual([{ port: 5173, pid: 200 }]);
    // Both are found now; a later tick checks nothing again.
    files.checked = [];
    await defaultSnapshot();
    expect(files.checked).toEqual([]);
  });
});

it('Windows keeps its own in-process snapshot', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  const { defaultSnapshot } = await load();
  await defaultSnapshot().catch(() => undefined);
  expect(native.load).not.toHaveBeenCalled();
  expect(spawn.execFile).not.toHaveBeenCalled();
});
