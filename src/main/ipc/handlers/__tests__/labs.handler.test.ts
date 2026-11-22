import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonClient } from '../../../DaemonClient';
const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  read: vi.fn(), write: vi.fn(), inConfig: vi.fn((): boolean | null => null),
  app: { isPackaged: false, getAppPath: () => '/repo' },
  readFile: vi.fn(async (file: string) => Buffer.from(file)),
}));
vi.mock('electron', () => ({ app: h.app, ipcMain: {
  removeHandler: (key: string) => h.handlers.delete(key),
  handle: (key: string, fn: (...args: unknown[]) => Promise<unknown>) => h.handlers.set(key, fn),
} }));
vi.mock('fs/promises', () => ({ readFile: h.readFile }));
vi.mock('../../../../shared/labsSettings', () => ({
  readLabsSettings: h.read, writeLabsSettings: h.write, ringCompressionInConfig: h.inConfig,
}));
vi.mock('../../../../shared/terminalCoreSettings', () => ({ terminalCoreStopCommand: () => 'wmux daemon stop' }));
import { registerLabsHandlers } from '../labs.handler';
import { IPC } from '../../../../shared/constants';
const invoke = (key: string, value?: unknown) => {
  const handler = h.handlers.get(key);
  if (!handler) throw new Error('Missing handler');
  return handler(null, value);
};
beforeEach(() => { vi.clearAllMocks(); h.inConfig.mockReturnValue(null); h.handlers.clear(); });

describe('labs settings IPC', () => {
  it('asks for no restart without a daemon answer', async () => {
    for (const ringCompression of [false, true]) {
      h.read.mockReturnValue({ ringCompression });
      registerLabsHandlers();
      expect(await invoke(IPC.LABS_SETTINGS_GET)).toMatchObject({ running: null, restartRequired: false });
      const rpc = vi.fn().mockRejectedValue(new Error('offline'));
      registerLabsHandlers({ rpc } as unknown as DaemonClient);
      expect(await invoke(IPC.LABS_SETTINGS_GET)).toMatchObject({ running: null, restartRequired: false });
    }
  });
  it('compares the saved switch with what the daemon reports, on any engine', async () => {
    h.read.mockReturnValue({ ringCompression: true });
    const rpc = vi.fn().mockResolvedValue({ labs: { ringCompression: true } });
    registerLabsHandlers({ rpc } as unknown as DaemonClient);
    expect(await invoke(IPC.LABS_SETTINGS_GET)).toMatchObject({ restartRequired: false });
    expect(rpc).toHaveBeenCalledWith('daemon.ping', { includeLabs: true });
    rpc.mockResolvedValue({ labs: { ringCompression: false } });
    expect(await invoke(IPC.LABS_SETTINGS_GET)).toMatchObject({ restartRequired: true });
  });
  it('asks for a restart when config.json turns compression on but the daemon started without it', async () => {
    h.read.mockReturnValue({ ringCompression: false });
    h.inConfig.mockReturnValue(true);
    const rpc = vi.fn().mockResolvedValue({ labs: { ringCompression: false } });
    registerLabsHandlers({ rpc } as unknown as DaemonClient);
    expect(await invoke(IPC.LABS_SETTINGS_GET)).toMatchObject({ ringCompressionInConfig: true, restartRequired: true });
    rpc.mockResolvedValue({ labs: { ringCompression: true } });
    expect(await invoke(IPC.LABS_SETTINGS_GET)).toMatchObject({ restartRequired: false });
  });
  it('lets a config.json false win over the saved switch, with no restart once the daemon runs it', async () => {
    h.read.mockReturnValue({ ringCompression: true });
    h.inConfig.mockReturnValue(false);
    const rpc = vi.fn().mockResolvedValue({ labs: { ringCompression: false } });
    registerLabsHandlers({ rpc } as unknown as DaemonClient);
    expect(await invoke(IPC.LABS_SETTINGS_GET)).toMatchObject({ ringCompressionInConfig: false, restartRequired: false });
    // A daemon still compressing from before the edit is waiting for a restart.
    rpc.mockResolvedValue({ labs: { ringCompression: true } });
    expect(await invoke(IPC.LABS_SETTINGS_GET)).toMatchObject({ restartRequired: true });
  });
  it('hands over the wongtty engine and front end from node_modules, or from resources once packaged', async () => {
    registerLabsHandlers();
    const text = async () => {
      const wasm = await invoke(IPC.LABS_WONGTTY_WASM) as { engine: Buffer; frontEnd: Buffer };
      return [wasm.engine.toString(), wasm.frontEnd.toString()];
    };
    expect(await text()).toEqual([
      path.join('/repo', 'node_modules', 'wongtty', 'dist', 'wongtty.wasm'),
      path.join('/repo', 'node_modules', 'wongtty', 'dist', 'xterm_web_bg.wasm'),
    ]);
    h.app.isPackaged = true;
    const electronProcess = process as { resourcesPath?: string };
    electronProcess.resourcesPath = '/app/resources';
    try {
      expect(await text()).toEqual([path.join('/app/resources', 'wongtty.wasm'), path.join('/app/resources', 'xterm_web_bg.wasm')]);
    } finally {
      h.app.isPackaged = false;
      delete electronProcess.resourcesPath;
    }
  });
  it('serves broken wasm for WMUX_E2E_WONGTTY_WASM=broken in a development build only', async () => {
    registerLabsHandlers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    process.env.WMUX_E2E_WONGTTY_WASM = 'broken';
    const electronProcess = process as { resourcesPath?: string };
    try {
      const dev = await invoke(IPC.LABS_WONGTTY_WASM) as { engine: Buffer };
      expect(dev.engine.toString()).toBe('not wasm');
      expect(h.readFile).not.toHaveBeenCalled();
      h.app.isPackaged = true;
      electronProcess.resourcesPath = '/app/resources';
      const packaged = await invoke(IPC.LABS_WONGTTY_WASM) as { engine: Buffer };
      expect(packaged.engine.toString()).toBe(path.join('/app/resources', 'wongtty.wasm'));
      // Every call is logged, so an e2e can tell that nothing asked for it.
      expect(log.mock.calls.filter(([m]) => String(m).startsWith('[wmux:wongtty] wasm served'))).toHaveLength(2);
    } finally {
      delete process.env.WMUX_E2E_WONGTTY_WASM;
      h.app.isPackaged = false;
      delete electronProcess.resourcesPath;
      log.mockRestore();
    }
  });
});
