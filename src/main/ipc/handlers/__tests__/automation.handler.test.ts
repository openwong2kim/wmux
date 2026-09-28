import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, fn),
    removeHandler: (channel: string) => handlers.delete(channel),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    removeListener: vi.fn(),
  },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showMessageBox: vi.fn() },
}));

import { IPC } from '../../../../shared/constants';
import { AUTOMATION_RPC } from '../../../../shared/automation';
import { registerAutomationHandlers } from '../automation.handler';

const rpc = vi.fn();
const client = { isConnected: true, rpc } as never;
const confirm = vi.fn();
const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: {} }, ...args);

beforeEach(() => {
  handlers.clear();
  rpc.mockReset();
  confirm.mockReset();
  registerAutomationHandlers(() => client, confirm);
});

describe('automation IPC handlers', () => {
  it('asks main to confirm every Bypass grant and refuses on cancel', async () => {
    rpc.mockImplementation(async (method: string) =>
      method === AUTOMATION_RPC.list ? { automations: [{ id: 'a1', name: 'Nightly' }] } : { ok: true, automation: { id: 'a1' } });
    confirm.mockResolvedValue(false);
    await expect(call(IPC.AUTOMATION_GRANT, 'a1', 'bypass')).resolves.toEqual({ ok: false, error: 'cancelled' });
    expect(confirm).toHaveBeenCalledWith(null, 'Nightly');
    expect(rpc).not.toHaveBeenCalledWith(AUTOMATION_RPC.grant, expect.anything());

    confirm.mockResolvedValue(true);
    await expect(call(IPC.AUTOMATION_GRANT, 'a1', 'bypass')).resolves.toMatchObject({ ok: true });
    expect(rpc).toHaveBeenCalledWith(AUTOMATION_RPC.grant, { id: 'a1', mode: 'bypass' });

    confirm.mockClear();
    await call(IPC.AUTOMATION_GRANT, 'a1', 'approval');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('never widens a malformed automationId to every run', async () => {
    rpc.mockResolvedValue({ runs: [{ id: 'r1' }] });
    await expect(call(IPC.AUTOMATION_RUNS, { evil: true })).resolves.toEqual({ runs: [] });
    await expect(call(IPC.AUTOMATION_RUNS, undefined)).resolves.toEqual({ runs: [{ id: 'r1' }] });
  });

  it('reports unavailable only for an older daemon, not a transient failure', async () => {
    rpc.mockRejectedValueOnce(new Error('RPC timeout: automation.list (5000ms)'));
    await expect(call(IPC.AUTOMATION_LIST)).resolves.toMatchObject({ available: true, error: expect.any(String) });
    rpc.mockRejectedValueOnce(new Error('Unknown method: automation.list'));
    await expect(call(IPC.AUTOMATION_LIST)).resolves.toEqual({ automations: [], available: false });
  });
});
