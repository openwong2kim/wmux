import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Electron wiring around the stop key (src/main/computer/index.ts): held
// only while the switch is on, given back when it goes off and on quit, and
// reported to Settings. Electron, the switch file and the helper path are the
// mocked boundaries; the real StopKey and ComputerService run.

const h = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const shortcuts = new Map<string, () => void>();
  return {
    handlers,
    shortcuts,
    chordFree: { value: true },
    enabled: { value: false },
    helper: { value: 'ready' as 'ready' | 'missing' | 'unsupported' },
    register: vi.fn((accel: string, cb: () => void) => {
      if (!h.chordFree.value) return false;
      shortcuts.set(accel, cb);
      return true;
    }),
    unregister: vi.fn((accel: string) => { shortcuts.delete(accel); }),
  };
});

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => 'C:/wmux', getAppMetrics: () => [] },
  globalShortcut: { register: h.register, unregister: h.unregister },
  ipcMain: {
    removeHandler: (channel: string) => { h.handlers.delete(channel); },
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => { h.handlers.set(channel, fn); },
  },
}));
vi.mock('../../../shared/computer/config', () => ({ readComputerUseEnabled: () => h.enabled.value }));
// Never spawn anything: every helper request fails as a missing binary would.
vi.mock('../HelperProcess', () => ({
  HelperProcess: class {
    request() { return Promise.reject(new Error('[helper_unavailable] no helper in this test')); }
    abort() { /* nothing in flight */ }
    dispose() { /* nothing to stop */ }
  },
}));
// A helper path on every OS, so the lifecycle runs the same on Linux CI (whose
// real path resolves to null → unsupported_platform before the stop key).
vi.mock('../helperPath', () => ({ resolveHelperPathFor: () => 'C:/wmux/fake-helper.exe' }));
vi.mock('../settings', () => ({
  helperStatus: () => h.helper.value,
  writeComputerUseEnabled: (enabled: boolean) => { h.enabled.value = enabled; return enabled; },
}));

// Control, not Cmd, on macOS (Cmd+Option+Shift+Esc force-quits the front app).
const ACCEL = process.platform === 'darwin' ? 'Control+Alt+Shift+Escape' : 'CommandOrControl+Alt+Shift+Escape';

async function load() {
  vi.resetModules();
  const mod = await import('../index');
  const { IPC } = await import('../../../shared/constants');
  let service: import('../ComputerService').ComputerService | null = null;
  mod.registerComputerUseIpc(() => service);
  const handler = (channel: string) => {
    const fn = h.handlers.get(channel);
    if (!fn) throw new Error(`no handler for ${channel}`);
    return fn;
  };
  const get = () => handler(IPC.COMPUTER_USE_GET)({}) as { stopKeyStatus: string; enabled: boolean };
  const set = (on: boolean) => handler(IPC.COMPUTER_USE_SET)({}, on) as { stopKeyStatus: string; enabled: boolean };
  const create = () => {
    service = mod.createComputerService({ requestConsent: async () => 'approved' });
    return service;
  };
  return { mod, get, set, create };
}

beforeEach(() => {
  h.handlers.clear();
  h.shortcuts.clear();
  h.register.mockClear();
  h.unregister.mockClear();
  h.chordFree.value = true;
  h.enabled.value = false;
  h.helper.value = 'ready';
});

describe('computer-use stop key lifecycle', () => {
  it('is not claimed while computer use is off', async () => {
    const { get } = await load();
    expect(get().stopKeyStatus).toBe('off');
    expect(h.register).not.toHaveBeenCalled();
  });

  it('is held when the switch goes on and given back when it goes off', async () => {
    const { set, create } = await load();
    const service = create();
    const abort = vi.spyOn(service, 'abort');
    expect(set(true)).toMatchObject({ enabled: true, stopKeyStatus: 'held' });
    expect(h.shortcuts.has(ACCEL)).toBe(true);
    // The chord reaches the live service.
    h.shortcuts.get(ACCEL)?.();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(set(false)).toMatchObject({ enabled: false, stopKeyStatus: 'off' });
    expect(h.unregister).toHaveBeenCalledWith(ACCEL);
    expect(h.shortcuts.has(ACCEL)).toBe(false);
    // Turning it off also stopped what was in flight.
    expect(abort).toHaveBeenCalledTimes(2);
  });

  it('tells Settings when the chord is taken, and refuses input (fail closed)', async () => {
    h.chordFree.value = false;
    const { set, create } = await load();
    expect(set(true).stopKeyStatus).toBe('unavailable');
    const service = create();
    const err = await service.control({ key: 'k', label: 'k' }, { action: 'click', snapshotId: 's', index: 1 }).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('stop_key_unavailable');
  });

  it('is taken by the first call while the switch is on, and released by a call that finds it off', async () => {
    const { create } = await load();
    const service = create();
    h.enabled.value = true;
    // No helper binary in this build: the call fails, but the key is held first.
    await service.listApps().catch(() => undefined);
    expect(h.shortcuts.has(ACCEL)).toBe(true);
    h.enabled.value = false; // switched off by editing the file
    await service.listApps().catch(() => undefined);
    expect(h.shortcuts.has(ACCEL)).toBe(false);
  });

  it('is given back and the service disposed on quit', async () => {
    const { mod, set, create } = await load();
    const service = create();
    const dispose = vi.spyOn(service, 'dispose');
    set(true);
    mod.disposeComputerUse(service);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(h.unregister).toHaveBeenCalledWith(ACCEL);
  });

  it('stays free while this build has no helper, even with the switch on', async () => {
    h.helper.value = 'missing';
    h.enabled.value = true;
    const { get, create } = await load();
    expect(get()).toMatchObject({ enabled: true, stopKeyStatus: 'off' });
    const service = create();
    await service.listApps().catch(() => undefined);
    await service.control({ key: 'k', label: 'k' }, { action: 'click', snapshotId: 's', index: 1 }).catch(() => undefined);
    expect(h.register).not.toHaveBeenCalled();
  });

  it('cannot be switched on without a helper, but can be switched off', async () => {
    h.helper.value = 'missing';
    const { set } = await load();
    const refused = set(true) as { enabled: boolean; error?: string };
    expect(refused.enabled).toBe(false);
    expect(refused.error).toMatch(/does not include the computer-use helper/);
    h.enabled.value = true; // already on from 3.65.0
    expect(set(false)).toMatchObject({ enabled: false, stopKeyStatus: 'off' });
  });
});

describe('computer use without a helper binary', () => {
  it('fails every call with helper_unavailable and a plain message, no path', async () => {
    h.helper.value = 'missing';
    h.enabled.value = true;
    const { create } = await load();
    const service = create();
    for (const call of [
      () => service.listApps(),
      () => service.capabilities(),
      () => service.control({ key: 'k', label: 'k' }, { action: 'click', snapshotId: 's', index: 1 }),
    ]) {
      const err = (await call().catch((e: unknown) => e)) as { code?: string; message?: string };
      expect(err.code).toBe('helper_unavailable');
      expect(err.message).toMatch(/does not include the computer-use helper .* later release/);
      expect(err.message).toMatch(/do not try other ways to control the desktop/);
      expect(err.message).not.toMatch(/[\\/]|ENOENT|fake-helper/);
    }
  });

  it('uses a stop chord macOS does not treat as force quit', async () => {
    const { mod } = await load();
    expect(mod.stopKeyAcceleratorFor('darwin')).toBe('Control+Alt+Shift+Escape');
    expect(mod.stopKeyAcceleratorFor('win32')).toBe('CommandOrControl+Alt+Shift+Escape');
    expect(mod.stopKeyAcceleratorFor('linux')).toBe('CommandOrControl+Alt+Shift+Escape');
  });
});
