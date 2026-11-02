import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonClient } from '../../../DaemonClient';
const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  read: vi.fn(), write: vi.fn(), inConfig: vi.fn(() => false),
}));
vi.mock('electron', () => ({ ipcMain: {
  removeHandler: (key: string) => h.handlers.delete(key),
  handle: (key: string, fn: (...args: unknown[]) => Promise<unknown>) => h.handlers.set(key, fn),
} }));
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
beforeEach(() => { vi.clearAllMocks(); h.inConfig.mockReturnValue(false); h.handlers.clear(); });
const core = (effective: 'node' | 'rust') => ({ requested: effective, effective, rustAvailable: true, environmentOverride: false });

describe('labs settings IPC', () => {
  it('asks for no restart without a daemon answer while the saved opt-in is off', async () => {
    h.read.mockReturnValue({ ringCompression: false });
    registerLabsHandlers();
    expect(await invoke(IPC.LABS_SETTINGS_GET)).toMatchObject({ running: null, restartRequired: false });
    const rpc = vi.fn().mockRejectedValue(new Error('offline'));
    registerLabsHandlers({ rpc } as unknown as DaemonClient);
    expect(await invoke(IPC.LABS_SETTINGS_GET)).toMatchObject({ running: null, restartRequired: false });
  });
  it('asks for a restart without a daemon answer only while the saved opt-in is on', async () => {
    h.read.mockReturnValue({ ringCompression: true });
    registerLabsHandlers();
    expect(await invoke(IPC.LABS_SETTINGS_GET)).toMatchObject({ restartRequired: true });
  });
  it('compares the saved opt-in with what the daemon reports', async () => {
    h.read.mockReturnValue({ ringCompression: true });
    const rpc = vi.fn().mockResolvedValue({ labs: { ringCompression: true }, terminalCore: core('node') });
    registerLabsHandlers({ rpc } as unknown as DaemonClient);
    expect(await invoke(IPC.LABS_SETTINGS_GET)).toMatchObject({ restartRequired: false });
    rpc.mockResolvedValue({ labs: { ringCompression: false }, terminalCore: core('node') });
    expect(await invoke(IPC.LABS_SETTINGS_GET)).toMatchObject({ restartRequired: true });
  });
  it('says ring compression applies only while the daemon runs the Node engine', async () => {
    h.read.mockReturnValue({ ringCompression: true });
    const rpc = vi.fn().mockResolvedValue({ labs: { ringCompression: false }, terminalCore: core('rust') });
    registerLabsHandlers({ rpc } as unknown as DaemonClient);
    expect(rpc).not.toHaveBeenCalled();
    expect(await invoke(IPC.LABS_SETTINGS_GET)).toMatchObject({ ringCompressionApplies: false, restartRequired: false });
    expect(rpc).toHaveBeenCalledWith('daemon.ping', expect.objectContaining({ includeTerminalCore: true }));
    rpc.mockResolvedValue({ labs: { ringCompression: true }, terminalCore: core('node') });
    expect(await invoke(IPC.LABS_SETTINGS_GET)).toMatchObject({ ringCompressionApplies: true });
    rpc.mockResolvedValue({ labs: { ringCompression: true } });
    expect(await invoke(IPC.LABS_SETTINGS_GET)).toMatchObject({ ringCompressionApplies: null });
  });
  it('asks for a restart when config.json turns compression on but the daemon started without it', async () => {
    h.read.mockReturnValue({ ringCompression: false });
    h.inConfig.mockReturnValue(true);
    const rpc = vi.fn().mockResolvedValue({ labs: { ringCompression: false }, terminalCore: core('node') });
    registerLabsHandlers({ rpc } as unknown as DaemonClient);
    expect(await invoke(IPC.LABS_SETTINGS_GET)).toMatchObject({ restartRequired: true });
    rpc.mockResolvedValue({ labs: { ringCompression: true }, terminalCore: core('node') });
    expect(await invoke(IPC.LABS_SETTINGS_GET)).toMatchObject({ restartRequired: false });
  });
});
