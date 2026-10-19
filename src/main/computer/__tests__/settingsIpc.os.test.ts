import { beforeEach, describe, expect, it, vi } from 'vitest';

// Settings › Computer use over IPC (src/main/computer/index.ts): the option
// writes, the overlay push to a running helper, and the macOS permission
// buttons. Electron, child_process, the file and the helper are mocked
// boundaries; the real permissions module runs, so the exact commands show.

const BINARY = '/Applications/wmux.app/Contents/Resources/computer-use-macos/wmux Computer Use.app/Contents/MacOS/wmux-computer-use';
const APP = '/Applications/wmux.app/Contents/Resources/computer-use-macos/wmux Computer Use.app';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  file: { enabled: false, askPerApp: undefined as boolean | undefined, overlay: undefined as boolean | undefined },
  writes: [] as unknown[],
  verify: vi.fn(async (_command: string) => undefined),
  execFile: vi.fn(),
  spawn: vi.fn(),
  showItemInFolder: vi.fn(),
  probe: { permissions: { accessibility: true, screenRecording: false } as { accessibility: boolean; screenRecording: boolean } | null },
  probes: [] as string[],
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/src/wmux', getAppMetrics: () => [] },
  globalShortcut: { register: () => true, unregister: () => undefined },
  shell: { showItemInFolder: h.showItemInFolder },
  ipcMain: {
    removeHandler: (channel: string) => { h.handlers.delete(channel); },
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => { h.handlers.set(channel, fn); },
  },
}));
vi.mock('node:child_process', () => ({ execFile: h.execFile, spawn: h.spawn }));
// The handlers take the platform as an argument; the helper gates still look
// at the host. CI's Windows runner is an elevated admin, which would read as
// an `elevated` helper and refuse every button.
vi.mock('../selfElevation', () => ({ isSelfElevated: () => false }));
vi.mock('../../../shared/computer/config', () => ({
  readComputerUseEnabled: () => h.file.enabled,
  readComputerUseAskPerApp: () => h.file.askPerApp === true,
  readComputerUseOverlay: () => h.file.overlay !== false,
}));
vi.mock('../settings', () => ({
  helperStatus: () => 'ready',
  writeComputerUseSettings: (patch: Record<string, boolean>) => {
    h.writes.push(patch);
    Object.assign(h.file, patch);
  },
}));
vi.mock('../helperPath', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../helperPath')>()),
  resolveHelperPathFor: () => BINARY,
}));
vi.mock('../verifyHelper', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../verifyHelper')>()),
  createHelperVerifier: () => h.verify,
}));
// The permission probe: a short-lived helper that reports its grants.
vi.mock('../HelperProcess', () => ({
  HelperProcess: class {
    constructor(opts: { command: string }) { h.probes.push(opts.command); }
    async request() {
      if (!h.probe.permissions) throw new Error('[helper_unavailable] no helper');
      return { actions: [], modes: [], permissions: h.probe.permissions };
    }
    abort() { /* nothing in flight */ }
    dispose() { /* nothing to stop */ }
  },
}));

type Payload = import('../../../shared/computer/config').ComputerUseSettingsPayload;

async function load(platform: NodeJS.Platform = 'darwin') {
  vi.resetModules();
  const mod = await import('../index');
  const { IPC } = await import('../../../shared/constants');
  const service = { abort: vi.fn(), reconfigure: vi.fn(async () => undefined), resetHelper: vi.fn() };
  mod.registerComputerUseIpc(() => service as never, platform);
  const call = (channel: string, ...args: unknown[]) => h.handlers.get(channel)!({}, ...args) as Promise<Payload>;
  return {
    service,
    get: () => call(IPC.COMPUTER_USE_GET),
    set: (patch: unknown) => call(IPC.COMPUTER_USE_SET, patch),
    permissions: (op: unknown) => call(IPC.COMPUTER_USE_PERMISSIONS, { op }),
  };
}

beforeEach(() => {
  h.handlers.clear();
  h.file = { enabled: false, askPerApp: undefined, overlay: undefined };
  h.writes = [];
  h.probes = [];
  h.probe.permissions = { accessibility: true, screenRecording: false };
  for (const fn of [h.verify, h.execFile, h.spawn, h.showItemInFolder]) fn.mockReset();
  h.verify.mockResolvedValue(undefined);
  h.execFile.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => cb(null));
  h.spawn.mockReturnValue({ unref: vi.fn(), on: vi.fn() });
});

describe('Settings › Computer use options', () => {
  it('reads askPerApp off and the overlay on by default', async () => {
    const { get } = await load();
    expect(await get()).toMatchObject({ askPerApp: false, overlay: true });
  });

  it('writes askPerApp and overlay as a patch, and pushes only an overlay change to the helper', async () => {
    const { set, service } = await load();
    expect(await set({ askPerApp: true })).toMatchObject({ askPerApp: true, overlay: true });
    expect(service.reconfigure).not.toHaveBeenCalled();
    expect(await set({ overlay: false })).toMatchObject({ askPerApp: true, overlay: false });
    expect(service.reconfigure).toHaveBeenCalledTimes(1);
    expect(h.writes).toEqual([{ askPerApp: true }, { overlay: false }]);
  });

  it('still takes the bare boolean switch, and refuses a malformed patch', async () => {
    const { set } = await load();
    expect(await set(true)).toMatchObject({ enabled: true });
    expect(h.writes).toEqual([{ enabled: true }]);
    await expect(set({ askPerApp: 'yes' })).rejects.toThrow(/askPerApp must be a boolean/);
  });

  it('reports the grants from a fresh probe and the helper .app on macOS, only while computer use is on', async () => {
    const { get } = await load();
    const off = await get();
    expect(off.permissions).toBeUndefined();
    expect(off.helperAppPath).toBe(APP);
    expect(h.probes).toEqual([]);
    h.file.enabled = true;
    expect((await get()).permissions).toEqual({ accessibility: true, screenRecording: false });
    expect(h.probes).toEqual([BINARY]);
    h.probe.permissions = null;
    expect((await get()).permissions).toBeUndefined();
  });

  it('sends no helper path or grants off macOS', async () => {
    h.file.enabled = true;
    const { get } = await load('win32');
    const payload = await get();
    expect(payload.helperAppPath).toBeUndefined();
    expect(payload.permissions).toBeUndefined();
    expect(h.probes).toEqual([]);
  });
});

describe('Settings › Computer use permission buttons', () => {
  it('Request access spawns the verified helper with --request-permissions and retires the running one', async () => {
    const { permissions, service } = await load();
    await permissions('request');
    expect(h.verify).toHaveBeenCalledWith(BINARY);
    expect(h.spawn).toHaveBeenCalledWith(BINARY, ['--request-permissions'], { stdio: 'ignore' });
    expect(h.verify.mock.invocationCallOrder[0]).toBeLessThan(h.spawn.mock.invocationCallOrder[0]);
    expect(service.resetHelper).toHaveBeenCalled();
  });

  it('Request access never spawns a helper that failed verification', async () => {
    h.verify.mockRejectedValueOnce(new Error('bad signature'));
    const { permissions } = await load();
    await expect(permissions('request')).rejects.toThrow('bad signature');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('Reset access runs exactly the two tccutil resets for the helper', async () => {
    const { permissions, service } = await load();
    await permissions('reset');
    expect(h.execFile.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['/usr/bin/tccutil', ['reset', 'Accessibility', 'com.electron.wmux.computer-use']],
      ['/usr/bin/tccutil', ['reset', 'ScreenCapture', 'com.electron.wmux.computer-use']],
    ]);
    expect(service.resetHelper).toHaveBeenCalled();
  });

  it('Show helper in Finder reveals the .app', async () => {
    const { permissions } = await load();
    await permissions('reveal');
    expect(h.showItemInFolder).toHaveBeenCalledWith(APP);
  });

  it('refuses an unknown op, and every op off macOS', async () => {
    const mac = await load();
    await expect(mac.permissions('format')).rejects.toThrow(/op must be/);
    const win = await load('win32');
    await expect(win.permissions('reset')).rejects.toThrow(/macOS only/);
    expect(h.execFile).not.toHaveBeenCalled();
  });
});
