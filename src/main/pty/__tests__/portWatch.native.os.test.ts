import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// PortWatcher's macOS/Linux snapshot with the native module, child_process
// and the tool lookup stubbed: which path serves each tick, the failure
// latch, the kill switch, and the absolute-path fallback (no PATH walk).
const native = vi.hoisted(() => ({ processTable: vi.fn(), listeningSockets: vi.fn(), load: vi.fn(), capabilities: vi.fn() }));
const spawn = vi.hoisted(() => ({ execFile: vi.fn() }));
const present = vi.hoisted(() => ({ files: new Set<string>() }));

vi.mock('../../../shared/nativeTerminalCore', () => ({
  loadNativeTerminalCore: native.load,
  reportNativeFallback: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFile: spawn.execFile }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const existsSync = (p: string) => present.files.has(p);
  return { ...real, default: { ...real, existsSync }, existsSync };
});

const realPlatform = process.platform;

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
  native.processTable.mockReset().mockResolvedValue([{ pid: 200, ppid: 100, name: 'node' }]);
  native.listeningSockets.mockReset().mockResolvedValue([
    { pid: 200, port: 3000, address: '127.0.0.1', family: 4 },
    { pid: 200, port: 3000, address: '::1', family: 6 },
  ]);
  native.capabilities.mockReset().mockReturnValue(['process-table-v1', 'listen-sockets-v1']);
  native.load.mockReset().mockImplementation(() => ({
    processTable: native.processTable,
    listeningSockets: native.listeningSockets,
    nativeCoreCapabilities: native.capabilities,
  }));
  spawn.execFile.mockReset();
  present.files = new Set(['/bin/ps', '/usr/sbin/lsof', '/usr/bin/lsof']);
  spawnAnswers({
    '/bin/ps': '  200   100\n  100     1\n',
    '/usr/sbin/lsof': 'p200\nn127.0.0.1:5173\n',
    '/usr/bin/lsof': 'p200\nn*:5173\n',
  });
  delete process.env.WMUX_NATIVE_PROCESS_TABLE;
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
});

describe.each(['darwin', 'linux'] as const)('PortWatcher snapshot on %s', (platform) => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  });

  it('reads the native walk and socket list, without spawning', async () => {
    const { defaultSnapshot } = await load();
    const snap = await defaultSnapshot();
    expect([...snap.ppidByPid]).toEqual([[200, 100]]);
    expect(snap.listeners).toEqual([{ port: 3000, pid: 200 }, { port: 3000, pid: 200 }]);
    expect(native.load).toHaveBeenCalledWith('listen-sockets-v1');
    expect(native.processTable).toHaveBeenCalledWith(false);
    expect(spawn.execFile).not.toHaveBeenCalled();
  });

  it('sends a failed native tick to ps and lsof by absolute path, and latches after three in a row', async () => {
    const { defaultSnapshot } = await load();
    native.listeningSockets.mockRejectedValue(new Error('read failed'));
    for (let i = 0; i < 4; i++) {
      const snap = await defaultSnapshot();
      expect(snap.ppidByPid.get(200)).toBe(100);
      expect(snap.listeners).toEqual([{ port: 5173, pid: 200 }]);
    }
    expect(native.listeningSockets).toHaveBeenCalledTimes(3);
    const files = new Set(spawn.execFile.mock.calls.map((c) => c[0]));
    expect(files).toEqual(new Set(['/bin/ps', platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof']));
  });

  it('a success resets the failure count', async () => {
    const { defaultSnapshot } = await load();
    native.processTable.mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce(new Error('x'));
    for (let i = 0; i < 5; i++) await defaultSnapshot();
    native.processTable.mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce(new Error('x'));
    for (let i = 0; i < 3; i++) await defaultSnapshot();
    // Never three failures in a row: native still serves.
    expect(native.processTable).toHaveBeenCalledTimes(8);
  });

  it('uses ps and lsof when the module lacks the socket list or the walk', async () => {
    native.load.mockImplementation(() => { throw new Error('Native terminal core lacks listen-sockets-v1'); });
    let { defaultSnapshot } = await load();
    expect((await defaultSnapshot()).listeners).toEqual([{ port: 5173, pid: 200 }]);
    // A module whose capability list lacks the walk, or that lacks its export.
    for (const module of [
      { processTable: native.processTable, listeningSockets: native.listeningSockets, nativeCoreCapabilities: () => ['listen-sockets-v1'] },
      { listeningSockets: native.listeningSockets, nativeCoreCapabilities: native.capabilities },
    ]) {
      native.load.mockReset().mockImplementation(() => module);
      ({ defaultSnapshot } = await load());
      expect((await defaultSnapshot()).listeners).toEqual([{ port: 5173, pid: 200 }]);
    }
    expect(native.listeningSockets).not.toHaveBeenCalled();
    expect(native.processTable).not.toHaveBeenCalled();
    expect(spawn.execFile).toHaveBeenCalledTimes(6);
  });

  it('WMUX_NATIVE_PROCESS_TABLE=off keeps ps and lsof', async () => {
    process.env.WMUX_NATIVE_PROCESS_TABLE = 'off';
    const { defaultSnapshot } = await load();
    await defaultSnapshot();
    expect(native.load).not.toHaveBeenCalled();
    expect(spawn.execFile).toHaveBeenCalledTimes(2);
  });

  it('looks the tools up once, and skips one that is absent', async () => {
    process.env.WMUX_NATIVE_PROCESS_TABLE = 'off';
    present.files = new Set(platform === 'linux' ? ['/usr/bin/ps'] : []);
    spawnAnswers({ '/usr/bin/ps': '  200   100\n' });
    const { defaultSnapshot } = await load();
    const snap = await defaultSnapshot();
    expect(snap.listeners).toEqual([]);
    expect(spawn.execFile.mock.calls.map((c) => c[0])).toEqual(platform === 'linux' ? ['/usr/bin/ps'] : []);
    present.files = new Set(['/bin/ps', '/usr/sbin/lsof', '/usr/bin/lsof']);
    await defaultSnapshot();
    // The lookup is not repeated: the tools found missing stay missing.
    expect(spawn.execFile.mock.calls.length).toBe(platform === 'linux' ? 2 : 0);
  });
});

it('Windows keeps its own in-process snapshot', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  const { defaultSnapshot } = await load();
  await defaultSnapshot().catch(() => undefined);
  expect(native.load).not.toHaveBeenCalled();
  expect(spawn.execFile).not.toHaveBeenCalled();
});
