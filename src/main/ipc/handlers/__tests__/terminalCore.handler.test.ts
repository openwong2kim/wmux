import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonClient } from '../../../DaemonClient';
import type { TerminalCoreRuntime } from '../../../../shared/terminalCoreSettings';
const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  runtime: vi.fn(),
}));
vi.mock('electron', () => ({ ipcMain: {
  removeHandler: (key: string) => h.handlers.delete(key),
  handle: (key: string, fn: (...args: unknown[]) => Promise<unknown>) => h.handlers.set(key, fn),
} }));
vi.mock('../../../../shared/terminalCoreSettings', () => ({ terminalCoreRuntime: h.runtime }));
import { registerTerminalCoreHandlers } from '../terminalCore.handler';
import { IPC } from '../../../../shared/constants';
const rust: TerminalCoreRuntime = { requested: 'rust', effective: 'rust', rustAvailable: true, environmentOverride: false, available: true };
const invoke = (key: string) => {
  const handler = h.handlers.get(key);
  if (!handler) throw new Error('Missing handler');
  return handler(null);
};
beforeEach(() => { vi.clearAllMocks(); h.runtime.mockReturnValue(rust); });

describe('terminal engine status IPC (read-only)', () => {
  it('registers only the status read', () => {
    const cleanup = registerTerminalCoreHandlers();
    expect([...h.handlers.keys()]).toEqual([IPC.TERMINAL_CORE_SETTINGS_GET]);
    cleanup(); expect(h.handlers.size).toBe(0);
  });
  it('reports the app engine in local mode', async () => {
    registerTerminalCoreHandlers();
    expect(await invoke(IPC.TERMINAL_CORE_SETTINGS_GET)).toEqual({ runtime: rust, host: 'app' });
  });
  it('reports the daemon engine rather than the app engine, missing module included', async () => {
    const missing = { ...rust, rustAvailable: false, available: false, reason: 'not found' };
    const rpc = vi.fn().mockResolvedValue({ terminalCore: missing });
    registerTerminalCoreHandlers({ rpc } as unknown as DaemonClient);
    expect(await invoke(IPC.TERMINAL_CORE_SETTINGS_GET)).toEqual({ runtime: missing, host: 'daemon' });
    expect(rpc).toHaveBeenCalledWith('daemon.ping', { includeTerminalCore: true });
  });
  it('does not guess the backend of an old or disconnected daemon', async () => {
    const rpc = vi.fn().mockResolvedValue({ status: 'ok' });
    registerTerminalCoreHandlers({ rpc } as unknown as DaemonClient);
    expect(await invoke(IPC.TERMINAL_CORE_SETTINGS_GET)).toMatchObject({ runtime: null });
    rpc.mockRejectedValue(new Error('offline'));
    expect(await invoke(IPC.TERMINAL_CORE_SETTINGS_GET)).toMatchObject({ runtime: null });
  });
});
