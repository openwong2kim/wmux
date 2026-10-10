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
import { autoConfirmCopy, registerAutomationHandlers } from '../automation.handler';

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
    expect(confirm).toHaveBeenCalledWith(null, 'Nightly', 'bypass');
    expect(rpc).not.toHaveBeenCalledWith(AUTOMATION_RPC.grant, expect.anything());

    confirm.mockResolvedValue(true);
    await expect(call(IPC.AUTOMATION_GRANT, 'a1', 'bypass')).resolves.toMatchObject({ ok: true });
    expect(rpc).toHaveBeenCalledWith(AUTOMATION_RPC.grant, { id: 'a1', mode: 'bypass' });

    confirm.mockClear();
    await call(IPC.AUTOMATION_GRANT, 'a1', 'approval');
    await call(IPC.AUTOMATION_GRANT, 'a1', 'scoped', ['Read']);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks main to confirm every Auto grant; a decline sends no grant', async () => {
    rpc.mockImplementation(async (method: string) =>
      method === AUTOMATION_RPC.list ? { automations: [{ id: 'a1', name: 'Nightly' }] } : { ok: true, automation: { id: 'a1' } });
    confirm.mockResolvedValue(false);
    await expect(call(IPC.AUTOMATION_GRANT, 'a1', 'auto')).resolves.toEqual({ ok: false, error: 'cancelled' });
    expect(confirm).toHaveBeenCalledWith(null, 'Nightly', 'auto');
    expect(rpc).not.toHaveBeenCalledWith(AUTOMATION_RPC.grant, expect.anything());

    confirm.mockResolvedValue(true);
    await expect(call(IPC.AUTOMATION_GRANT, 'a1', 'auto')).resolves.toMatchObject({ ok: true });
    expect(rpc).toHaveBeenCalledWith(AUTOMATION_RPC.grant, { id: 'a1', mode: 'auto' });
  });

  it('pins the grant to the revision read before the prompt; an unknown schedule is never prompted', async () => {
    rpc.mockImplementation(async (method: string) =>
      method === AUTOMATION_RPC.list ? { automations: [{ id: 'a1', name: 'Nightly', revision: 3 }] } : { ok: true, automation: { id: 'a1' } });
    confirm.mockResolvedValue(true);
    await call(IPC.AUTOMATION_GRANT, 'a1', 'auto');
    expect(rpc).toHaveBeenCalledWith(AUTOMATION_RPC.grant, { id: 'a1', mode: 'auto', expectedRevision: 3 });
    confirm.mockClear();
    await expect(call(IPC.AUTOMATION_GRANT, 'gone', 'bypass')).resolves.toEqual({ ok: false, error: 'Not found' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('auto copy names the schedule on one line in both locales', () => {
    expect(autoConfirmCopy('en', 'Night\nly').message).toBe('Run "Night ly" in Claude\'s auto mode?');
    expect(autoConfirmCopy('ko', '').message).toContain('"wmux"');
    expect(autoConfirmCopy('ko', 'x').cancel).toBe('취소');
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

  it('passes enabled:false through to automation.create', async () => {
    rpc.mockResolvedValue({ ok: true, automation: { id: 'n1' } });
    const draft = { name: 'n', trigger: {}, action: {} };
    await call(IPC.AUTOMATION_CREATE, draft, false);
    expect(rpc).toHaveBeenCalledWith(AUTOMATION_RPC.create, { draft, enabled: false });
  });
});

describe('automation grant — browser identity', () => {
  const mainFrame = {};
  const wc = { isDestroyed: () => false, mainFrame };
  const win = { isDestroyed: () => false, webContents: wc };
  const confirmIdentity = vi.fn();
  let epoch = 7;
  let entry: Record<string, unknown> | null;
  let keyDir: string;

  beforeEach(async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-idkey-'));
    const { __setRunIdentityKeyDirForTest, setBrowserIdentitySources } = await import('../../../automation/runIdentity');
    __setRunIdentityKeyDirForTest(keyDir);
    epoch = 7;
    entry = { workspaceId: 'ws-1', paneId: 'pane-a', profileId: 'Work', protected: true, hosts: { mode: 'allowlist', allow: ['a.test'], block: [] } };
    setBrowserIdentitySources({
      epoch: () => epoch,
      entryFor: () => entry as never,
      profileFor: () => 'Work',
      paneBindings: () => ({ 'pane-a': { workspaceId: 'ws-1', profile: 'Work' } }),
    });
    confirmIdentity.mockReset();
    handlers.clear();
    registerAutomationHandlers(() => client, confirm, () => win as never, confirmIdentity, (paneId) => (paneId === 'pane-a' ? 'ws-1' : null));
    rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === AUTOMATION_RPC.capabilities) return { capabilities: ['browserIdentity'] };
      if (method === AUTOMATION_RPC.list) return { automations: [{ id: 'a1', name: 'Nightly', revision: 4, action: { agent: 'claude' } }] };
      return { ok: true, automation: { id: 'a1', params } };
    });
  });

  const fromMainFrame = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: wc, senderFrame: mainFrame }, ...args);
  const pick = { workspaceId: 'ws-1', paneId: 'pane-a', paneLabel: 'Shop' };
  const grantCall = () => rpc.mock.calls.find((c) => c[0] === AUTOMATION_RPC.grant);

  it('resolves, confirms and signs the identity at the next revision', async () => {
    confirmIdentity.mockResolvedValue(true);
    await expect(fromMainFrame(IPC.AUTOMATION_GRANT, 'a1', 'auto', undefined, pick)).resolves.toMatchObject({ ok: true });
    expect(confirmIdentity).toHaveBeenCalledWith(null, 'Nightly', { paneLabel: 'Shop', profileId: 'Work', hosts: ['a.test'], mode: 'auto' });
    // One prompt: the Auto confirm is folded into the identity confirm.
    expect(confirm).not.toHaveBeenCalled();
    const params = grantCall()?.[1] as { expectedRevision: number; browserIdentity: Record<string, unknown> };
    expect(params.expectedRevision).toBe(4);
    expect(params.browserIdentity).toMatchObject({ workspaceId: 'ws-1', paneId: 'pane-a', profileId: 'Work', hosts: ['a.test'], policyEpoch: 7, boundRevision: 5 });
    const { verifyBrowserIdentity } = await import('../../../automation/runIdentity');
    expect(verifyBrowserIdentity('a1', params.browserIdentity as never)).toBe(true);
    expect(verifyBrowserIdentity('a2', params.browserIdentity as never)).toBe(false);
    expect(verifyBrowserIdentity('a1', { ...params.browserIdentity, paneId: 'pane-b' } as never)).toBe(false);
  });

  it('accepts the identity from the main window top frame only', async () => {
    await expect(call(IPC.AUTOMATION_GRANT, 'a1', 'approval', undefined, pick)).resolves.toMatchObject({ ok: false });
    await expect(handlers.get(IPC.AUTOMATION_GRANT)!({ sender: wc, senderFrame: {} }, 'a1', 'approval', undefined, pick))
      .resolves.toMatchObject({ ok: false });
    expect(grantCall()).toBeUndefined();
    expect(confirmIdentity).not.toHaveBeenCalled();
  });

  it('refuses before sending anything to a daemon without the capability', async () => {
    rpc.mockImplementation(async (method: string) => {
      if (method === AUTOMATION_RPC.capabilities) throw new Error('Unknown method: automation.capabilities');
      return { ok: true, automation: { id: 'a1' } };
    });
    await expect(fromMainFrame(IPC.AUTOMATION_GRANT, 'a1', 'approval', undefined, pick)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('too old') });
    expect(grantCall()).toBeUndefined();
  });

  it('refuses a pane that is not protected, not confirmed, or not in the workspace', async () => {
    for (const bad of [{ ...entry, protected: false }, { ...entry, needsConfirm: true }, null]) {
      entry = bad;
      await expect(fromMainFrame(IPC.AUTOMATION_GRANT, 'a1', 'approval', undefined, pick)).resolves.toMatchObject({ ok: false });
    }
    entry = { workspaceId: 'ws-1', paneId: 'pane-a', profileId: 'Work', protected: true, hosts: { mode: 'allowlist', allow: [], block: [] } };
    await expect(fromMainFrame(IPC.AUTOMATION_GRANT, 'a1', 'approval', undefined, { ...pick, workspaceId: 'ws-2' })).resolves.toMatchObject({ ok: false });
    expect(confirmIdentity).not.toHaveBeenCalled();
    expect(grantCall()).toBeUndefined();
  });

  it('refuses when the policy moved while the prompt was open', async () => {
    confirmIdentity.mockImplementation(async () => { epoch = 8; return true; });
    await expect(fromMainFrame(IPC.AUTOMATION_GRANT, 'a1', 'approval', undefined, pick)).resolves.toMatchObject({ ok: false });
    expect(grantCall()).toBeUndefined();
  });

  it('removing the identity sends null; a grant without identity keeps today\'s shape', async () => {
    await fromMainFrame(IPC.AUTOMATION_GRANT, 'a1', 'approval', undefined, null);
    expect(grantCall()?.[1]).toEqual({ id: 'a1', mode: 'approval', expectedRevision: 4, browserIdentity: null });
    rpc.mockClear();
    await fromMainFrame(IPC.AUTOMATION_GRANT, 'a1', 'approval');
    expect(grantCall()?.[1]).toEqual({ id: 'a1', mode: 'approval' });
  });
});
