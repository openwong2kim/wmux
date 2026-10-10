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
    const { __setRunIdentityStoreDirForTest, setBrowserIdentitySources } = await import('../../../automation/runIdentity');
    __setRunIdentityStoreDirForTest(keyDir);
    epoch = 7;
    entry = { workspaceId: 'ws-1', paneId: 'pane-a', profileId: 'Work', protected: true, hosts: { mode: 'allowlist', allow: ['a.test'], block: [] } };
    setBrowserIdentitySources({
      entryFor: () => ({ ...entry, ...(epoch !== 7 && entry ? { hosts: { mode: 'allowlist', allow: ['changed.test'], block: [] } } : {}) }) as never,
      profileFor: () => 'Work',
      paneBindings: () => ({ 'pane-a': { workspaceId: 'ws-1', profile: 'Work' } }),
    });
    confirmIdentity.mockReset();
    handlers.clear();
    registerAutomationHandlers(() => client, confirm, () => win as never, confirmIdentity, (paneId) => (paneId === 'pane-a' ? 'ws-1' : null));
    rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === AUTOMATION_RPC.capabilities) return { capabilities: ['browserIdentity'] };
      if (method === AUTOMATION_RPC.list) return { automations: [{ id: 'a1', name: 'Nightly', revision: 4, action: { agent: 'claude' } }] };
      return { ok: true, automation: { id: 'a1', action: { browserIdentity: params?.['browserIdentity'] ?? undefined } } };
    });
  });

  const fromMainFrame = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: wc, senderFrame: mainFrame }, ...args);
  const pick = { workspaceId: 'ws-1', paneId: 'pane-a', paneLabel: 'Shop' };
  const grantCall = () => rpc.mock.calls.find((c) => c[0] === AUTOMATION_RPC.grant);

  it("records main's snapshot and sends the daemon only a reference at the next revision", async () => {
    confirmIdentity.mockResolvedValue(true);
    await expect(fromMainFrame(IPC.AUTOMATION_GRANT, 'a1', 'auto', undefined, pick)).resolves.toMatchObject({ ok: true });
    expect(confirmIdentity).toHaveBeenCalledWith(null, 'Nightly', { paneLabel: 'Shop', profileId: 'Work', hosts: ['a.test'], mode: 'auto' });
    // One prompt: the Auto confirm is folded into the identity confirm.
    expect(confirm).not.toHaveBeenCalled();
    const params = grantCall()?.[1] as { expectedRevision: number; browserIdentity: Record<string, unknown> };
    expect(params.expectedRevision).toBe(4);
    expect(params.browserIdentity).toEqual({ workspaceId: 'ws-1', paneId: 'pane-a', boundRevision: 5 });
    const fs = await import('node:fs');
    const path = await import('node:path');
    const stored = JSON.parse(fs.readFileSync(path.join(keyDir, 'browser-run-identities.json'), 'utf8'));
    expect(stored.entries['a1@5']).toMatchObject({ automationId: 'a1', boundRevision: 5, paneId: 'pane-a', profileId: 'Work', hosts: ['a.test'], mode: 'auto' });
  });

  it('the identity prompt states the mode it replaces the confirm for', async () => {
    const { identityConfirmCopy } = await import('../automation.handler');
    const view = { paneLabel: 'Shop', profileId: 'Work', hosts: ['a.test'] };
    expect(identityConfirmCopy('en', 'N', { ...view, mode: 'bypass' }).detail).toContain('without asking for approval');
    expect(identityConfirmCopy('en', 'N', { ...view, mode: 'bypass' }).confirm).toContain('Bypass');
    expect(identityConfirmCopy('en', 'N', { ...view, mode: 'auto' }).detail).toContain("Claude's auto mode");
    expect(identityConfirmCopy('en', 'N', { ...view, mode: 'auto' }).detail).not.toContain('none of');
    expect(identityConfirmCopy('ko', 'N', { ...view, mode: 'bypass' }).detail).toContain('승인을 묻지 않고');
  });

  it("a refused grant keeps the schedule's earlier snapshot; a landed one prunes it", async () => {
    confirmIdentity.mockResolvedValue(true);
    const { recordRunIdentity } = await import('../../../automation/runIdentity');
    await recordRunIdentity({ automationId: 'a1', boundRevision: 4, workspaceId: 'ws-1', paneId: 'pane-a', profileId: 'Work', hosts: [], fingerprint: '0'.repeat(64), mode: 'approval' });
    const fs = await import('node:fs');
    const path = await import('node:path');
    const read = () => Object.keys(JSON.parse(fs.readFileSync(path.join(keyDir, 'browser-run-identities.json'), 'utf8')).entries);
    rpc.mockImplementation(async (method: string) => {
      if (method === AUTOMATION_RPC.capabilities) return { capabilities: ['browserIdentity'] };
      if (method === AUTOMATION_RPC.list) return { automations: [{ id: 'a1', name: 'Nightly', revision: 4, action: { agent: 'claude' } }] };
      return { ok: false, error: 'changed' };
    });
    await fromMainFrame(IPC.AUTOMATION_GRANT, 'a1', 'approval', undefined, pick);
    expect(read()).toEqual(['a1@4']);
    rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === AUTOMATION_RPC.capabilities) return { capabilities: ['browserIdentity'] };
      if (method === AUTOMATION_RPC.list) return { automations: [{ id: 'a1', name: 'Nightly', revision: 4, action: { agent: 'claude' } }] };
      return { ok: true, automation: { id: 'a1', action: { browserIdentity: params['browserIdentity'] } } };
    });
    await fromMainFrame(IPC.AUTOMATION_GRANT, 'a1', 'approval', undefined, pick);
    expect(read()).toEqual(['a1@5']);
  });

  it('refuses when the daemon answers ok but did not keep the identity', async () => {
    confirmIdentity.mockResolvedValue(true);
    rpc.mockImplementation(async (method: string) => {
      if (method === AUTOMATION_RPC.capabilities) return { capabilities: ['browserIdentity'] };
      if (method === AUTOMATION_RPC.list) return { automations: [{ id: 'a1', name: 'Nightly', revision: 4, action: { agent: 'claude' } }] };
      return { ok: true, automation: { id: 'a1', action: {} } };
    });
    await expect(fromMainFrame(IPC.AUTOMATION_GRANT, 'a1', 'approval', undefined, pick)).resolves.toMatchObject({ ok: false });
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

  it('drops its snapshot when the daemon refuses the grant', async () => {
    confirmIdentity.mockResolvedValue(true);
    rpc.mockImplementation(async (method: string) => {
      if (method === AUTOMATION_RPC.capabilities) return { capabilities: ['browserIdentity'] };
      if (method === AUTOMATION_RPC.list) return { automations: [{ id: 'a1', name: 'Nightly', revision: 4, action: { agent: 'claude' } }] };
      return { ok: false, error: 'changed' };
    });
    await fromMainFrame(IPC.AUTOMATION_GRANT, 'a1', 'approval', undefined, pick);
    const fs = await import('node:fs');
    const path = await import('node:path');
    expect(JSON.parse(fs.readFileSync(path.join(keyDir, 'browser-run-identities.json'), 'utf8')).entries).toEqual({});
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
