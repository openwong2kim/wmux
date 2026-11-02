import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonClient } from '../../../DaemonClient';
const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  read: vi.fn(), write: vi.fn(),
}));
vi.mock('electron', () => ({ ipcMain: {
  removeHandler: (key: string) => h.handlers.delete(key),
  handle: (key: string, fn: (...args: unknown[]) => Promise<unknown>) => h.handlers.set(key, fn),
} }));
vi.mock('../../../../shared/labsSettings', () => ({
  readLabsSettings: h.read, writeLabsSettings: h.write, ringCompressionInConfig: () => false,
}));
vi.mock('../../../../shared/terminalCoreSettings', () => ({ terminalCoreStopCommand: () => 'wmux daemon stop' }));
import { registerLabsHandlers } from '../labs.handler';
import { IPC } from '../../../../shared/constants';
const invoke = (key: string, value?: unknown) => {
  const handler = h.handlers.get(key);
  if (!handler) throw new Error('Missing handler');
  return handler(null, value);
};
beforeEach(() => { vi.clearAllMocks(); h.handlers.clear(); });

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
    const rpc = vi.fn().mockResolvedValue({ labs: { ringCompression: true } });
    registerLabsHandlers({ rpc } as unknown as DaemonClient);
    expect(await invoke(IPC.LABS_SETTINGS_GET)).toMatchObject({ restartRequired: false });
    rpc.mockResolvedValue({ labs: { ringCompression: false } });
    expect(await invoke(IPC.LABS_SETTINGS_GET)).toMatchObject({ restartRequired: true });
  });
});
