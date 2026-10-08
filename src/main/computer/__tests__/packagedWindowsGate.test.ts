import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A packaged Windows wmux whose helper has no release signature (every 4.0.0
// install): the switch turns on and the helper runs, as long as its bytes
// match the SHA-256 pin. Electron, the switch file and the spawn are mocked;
// the real status gate and the real pin check (verifyHelper.ts) run.

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  enabled: { value: false },
  helperPath: { value: '' },
  pin: { sha256: '', releaseSigned: false },
  spawned: { count: 0 },
}));

vi.mock('electron', () => ({
  app: { isPackaged: true, getAppPath: () => 'C:/wmux/resources/app.asar', getAppMetrics: () => [] },
  globalShortcut: { register: () => true, unregister: () => undefined },
  ipcMain: {
    removeHandler: (channel: string) => { h.handlers.delete(channel); },
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => { h.handlers.set(channel, fn); },
  },
}));
vi.mock('../../../shared/computer/config', () => ({
  readComputerUseEnabled: () => h.enabled.value,
  readComputerUseAskPerApp: () => false,
  readComputerUseOverlay: () => true,
}));
vi.mock('../settings', () => ({
  helperStatus: () => 'ready',
  writeComputerUseSettings: (patch: { enabled?: boolean }) => { if (typeof patch.enabled === 'boolean') h.enabled.value = patch.enabled; },
}));
vi.mock('../helperPath', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../helperPath')>()),
  resolveHelperPathFor: () => h.helperPath.value,
}));
vi.mock('../selfElevation', () => ({ isSelfElevated: () => false }));
vi.mock('../helperPin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../helperPin')>()),
  WINDOWS_HELPER_PIN: h.pin,
}));
// The spawn itself: the real verifier runs first, as HelperProcess does.
vi.mock('../HelperProcess', () => ({
  HelperProcess: class {
    constructor(private readonly opts: { command: string; verify?: (command: string) => Promise<void> }) {}
    async request() {
      await this.opts.verify?.(this.opts.command);
      h.spawned.count += 1;
      return { apps: [] };
    }
    abort() { /* nothing in flight */ }
    dispose() { /* nothing to stop */ }
  },
}));

const realPlatform = process.platform;
let dir = '';

beforeAll(async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wmux-win-gate-'));
});

afterAll(async () => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
  await fs.rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  h.handlers.clear();
  h.enabled.value = false;
  h.spawned.count = 0;
  h.helperPath.value = path.join(dir, 'wmux-computer-use.exe');
  await fs.writeFile(h.helperPath.value, 'helper bytes');
  h.pin.sha256 = createHash('sha256').update('helper bytes').digest('hex');
  h.pin.releaseSigned = false;
});

async function load() {
  vi.resetModules();
  const mod = await import('../index');
  const { IPC } = await import('../../../shared/constants');
  mod.registerComputerUseIpc(() => null);
  const call = (channel: string, ...args: unknown[]) => h.handlers.get(channel)?.({}, ...args) as Record<string, unknown>;
  return {
    get: () => call(IPC.COMPUTER_USE_GET),
    set: (on: boolean) => call(IPC.COMPUTER_USE_SET, on),
    service: () => mod.createComputerService({ requestConsent: async () => 'approved' }),
  };
}

describe('packaged Windows build, helper without a release signature', () => {
  it('reports the helper ready, turns the switch on and runs a helper that matches the pin', async () => {
    const { get, set, service } = await load();
    expect(await get()).toMatchObject({ helper: 'ready', helperUnsigned: true });
    expect(await set(true)).toMatchObject({ enabled: true, helper: 'ready', stopKeyStatus: 'held' });
    await service().listApps().catch(() => undefined);
    expect(h.spawned.count).toBe(1);
  });

  it('still refuses a helper whose bytes do not match the pin', async () => {
    const { set, service } = await load();
    await set(true);
    await fs.appendFile(h.helperPath.value, 'x');
    const err = (await service().listApps().catch((e: unknown) => e)) as { code?: string; message?: string };
    expect(err.code).toBe('helper_unavailable');
    expect(err.message).toContain('does not match this wmux build');
    expect(h.spawned.count).toBe(0);
  });

  it('carries no unsigned note once the helper is release-signed', async () => {
    h.pin.releaseSigned = true;
    const { get } = await load();
    expect((await get()).helper).toBe('ready');
    expect((await get()).helperUnsigned).toBeUndefined();
  });
});
