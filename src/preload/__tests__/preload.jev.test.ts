// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElectronAPI } from '../preload';
import { IPC } from '../../shared/constants';

const { exposed, invoke } = vi.hoisted(() => ({
  exposed: {} as Record<string, unknown>,
  invoke: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => { exposed[key] = api; } },
  ipcRenderer: {
    invoke, on: vi.fn(), once: vi.fn(), off: vi.fn(), removeListener: vi.fn(),
    removeAllListeners: vi.fn(), send: vi.fn(), sendSync: vi.fn(),
  },
  webUtils: { getPathForFile: vi.fn() },
  webFrame: { setZoomFactor: vi.fn(), getZoomFactor: vi.fn(() => 1) },
}));

beforeAll(async () => { await import('../preload'); });
beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ enabled: false, hasKey: false });
});

describe('Jev session preload bridge', () => {
  it('reads only the session status channel', async () => {
    const api = (exposed.electronAPI as ElectronAPI).deck.jev;
    await expect(api.status()).resolves.toEqual({ enabled: false, hasKey: false });
    expect(invoke).toHaveBeenCalledExactlyOnceWith(IPC.DECK_JEV_STATUS);
  });

  it('forwards explicit key entry without adding enablement', async () => {
    const api = (exposed.electronAPI as ElectronAPI).deck.jev;
    invoke.mockResolvedValue({ enabled: false, hasKey: true });
    await expect(api.configure({ apiKey: 'dummy-test-key' })).resolves.toEqual({ enabled: false, hasKey: true });
    expect(invoke).toHaveBeenCalledExactlyOnceWith(IPC.DECK_JEV_CONFIGURE, { apiKey: 'dummy-test-key' });
  });

  it('forwards separate consent and clear requests unchanged', async () => {
    const api = (exposed.electronAPI as ElectronAPI).deck.jev;
    await api.configure({ enabled: true });
    await api.configure({ enabled: false });
    await api.configure({ clearKey: true });
    expect(invoke.mock.calls).toEqual([
      [IPC.DECK_JEV_CONFIGURE, { enabled: true }],
      [IPC.DECK_JEV_CONFIGURE, { enabled: false }],
      [IPC.DECK_JEV_CONFIGURE, { clearKey: true }],
    ]);
  });
});
