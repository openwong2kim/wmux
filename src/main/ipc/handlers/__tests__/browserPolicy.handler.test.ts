import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { BROWSER_POLICY_IPC, type PanePolicyDecision } from '../../../../shared/browserPolicy';
import {
  isTrustedMainFrameSender,
  registerBrowserPolicyIpc,
  UNTRUSTED_SENDER_ERROR,
} from '../browserPolicy.handler';
import { BrowserPolicyWriteError } from '../../../browser-session/BrowserPolicyStore';

function fakeWindow() {
  const mainFrame = { id: 'main-frame' };
  const webContents = { mainFrame, isDestroyed: () => false };
  return { win: { webContents, isDestroyed: () => false } as unknown as BrowserWindow, webContents, mainFrame };
}

describe('isTrustedMainFrameSender', () => {
  const { win, webContents, mainFrame } = fakeWindow();
  const getWindow = () => win;

  it('accepts only the main window top frame', () => {
    expect(isTrustedMainFrameSender({ sender: webContents, senderFrame: mainFrame } as never, getWindow)).toBe(true);
  });

  it('refuses a webview guest, a subframe, another window and a missing window', () => {
    const guest = { mainFrame: { id: 'g' } };
    expect(isTrustedMainFrameSender({ sender: guest, senderFrame: guest.mainFrame } as never, getWindow)).toBe(false);
    expect(isTrustedMainFrameSender({ sender: webContents, senderFrame: { id: 'sub' } } as never, getWindow)).toBe(false);
    const other = fakeWindow();
    expect(isTrustedMainFrameSender({ sender: other.webContents, senderFrame: other.mainFrame } as never, getWindow)).toBe(false);
    expect(isTrustedMainFrameSender({ sender: webContents, senderFrame: mainFrame } as never, () => null)).toBe(false);
  });
});

describe('registerBrowserPolicyIpc', () => {
  function setup() {
    const { win, webContents, mainFrame } = fakeWindow();
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
    const store = {
      fileState: () => 'missing' as const,
      epoch: () => 0,
      entryFor: () => null,
      decisionFor: vi.fn((): PanePolicyDecision => ({ kind: 'legacy' })),
      write: vi.fn(async () => 1),
    };
    const bindings: Record<string, { workspaceId: string; profile: string }> = {
      'pane-1': { workspaceId: 'ws-1', profile: 'pa' },
    };
    const blockedHostsFor = vi.fn((profile: string) =>
      profile === 'pa' ? [{ host: 'cdn.test', port: 443, lastSeen: 5, count: 2 }] : []);
    registerBrowserPolicyIpc({ handle: (ch: string, fn: never) => handlers.set(ch, fn) } as never, {
      getWindow: () => win,
      store,
      profileFor: () => 'pa',
      paneBindings: () => bindings,
      paneWorkspace: (paneId) => (paneId === 'pane-1' ? 'ws-1' : null),
      blockedHostsFor,
    });
    const trusted = { sender: webContents, senderFrame: mainFrame };
    return { handlers, store, trusted, bindings, blockedHostsFor };
  }
  const write = {
    workspaceId: 'ws-1',
    paneId: 'pane-1',
    profileId: 'pa',
    protected: true,
    hosts: { mode: 'allowlist', allow: ['a.test'], block: [] },
    expectedEpoch: 0,
  };

  it('refuses an untrusted sender on both channels without touching the store', async () => {
    const { handlers, store } = setup();
    const guest = { sender: { mainFrame: {} }, senderFrame: {} };
    expect(await handlers.get(BROWSER_POLICY_IPC.get)!(guest, { workspaceId: 'ws-1', paneId: 'pane-1' }))
      .toEqual({ ok: false, error: UNTRUSTED_SENDER_ERROR });
    expect(await handlers.get(BROWSER_POLICY_IPC.set)!(guest, write)).toEqual({ ok: false, error: UNTRUSTED_SENDER_ERROR });
    expect(store.write).not.toHaveBeenCalled();
  });

  it('refuses a pane that is not in the named workspace', async () => {
    const { handlers, store, trusted } = setup();
    expect(await handlers.get(BROWSER_POLICY_IPC.set)!(trusted, { ...write, workspaceId: 'ws-2' }))
      .toMatchObject({ ok: false });
    expect(store.write).not.toHaveBeenCalled();
  });

  it('writes for the trusted sender with the exclusive-profile verdict', async () => {
    const { handlers, store, trusted } = setup();
    expect(await handlers.get(BROWSER_POLICY_IPC.set)!(trusted, write)).toEqual({ ok: true, epoch: 1 });
    store.write.mockRejectedValueOnce(new BrowserPolicyWriteError('stale', 'changed'));
    expect(await handlers.get(BROWSER_POLICY_IPC.set)!(trusted, write)).toEqual({ ok: false, error: 'changed', code: 'stale' });
    expect(store.write).toHaveBeenCalledWith(expect.objectContaining({ paneId: 'pane-1' }), 'pa', true);
    expect(await handlers.get(BROWSER_POLICY_IPC.get)!(trusted, { workspaceId: 'ws-1', paneId: 'pane-1' }))
      .toMatchObject({ ok: true, state: 'missing', epoch: 0, currentProfile: 'pa', decision: 'legacy' });
  });

  it('reports the decision main would make for the pane', async () => {
    const { handlers, store, trusted } = setup();
    const read = () => handlers.get(BROWSER_POLICY_IPC.get)!(trusted, { workspaceId: 'ws-1', paneId: 'pane-1' });
    store.decisionFor.mockReturnValueOnce({ kind: 'denied', why: 'unreadable' });
    expect(await read()).toMatchObject({ ok: true, decision: 'denied' });
    expect(store.decisionFor).toHaveBeenLastCalledWith('pane-1', 'ws-1', 'pa', true);
    store.decisionFor.mockReturnValueOnce({
      kind: 'protected', epoch: 2, profileId: 'pa', hosts: { mode: 'allowlist', allow: [], block: [] }, confirmed: false,
    });
    expect(await read()).toMatchObject({ decision: 'protected', confirmed: false });
  });

  describe('recently blocked hosts (#2063)', () => {
    const where = { workspaceId: 'ws-1', paneId: 'pane-1' };

    it('refuses a webview guest, a subframe and another window without reading the list', async () => {
      const { handlers, blockedHostsFor, trusted } = setup();
      const read = handlers.get(BROWSER_POLICY_IPC.blocked)!;
      const guest = { sender: { mainFrame: {} }, senderFrame: {} };
      const subframe = { sender: trusted.sender, senderFrame: { id: 'sub' } };
      const other = fakeWindow();
      for (const sender of [guest, subframe, { sender: other.webContents, senderFrame: other.mainFrame }]) {
        expect(await read(sender, where)).toEqual({ ok: false, error: UNTRUSTED_SENDER_ERROR });
      }
      expect(blockedHostsFor).not.toHaveBeenCalled();
    });

    it('refuses a pane that is not in the named workspace', async () => {
      const { handlers, blockedHostsFor, trusted } = setup();
      expect(await handlers.get(BROWSER_POLICY_IPC.blocked)!(trusted, { ...where, workspaceId: 'ws-2' }))
        .toMatchObject({ ok: false });
      expect(await handlers.get(BROWSER_POLICY_IPC.blocked)!(trusted, {})).toMatchObject({ ok: false });
      expect(blockedHostsFor).not.toHaveBeenCalled();
    });

    it("answers the trusted sender with the pane's own profile's list", async () => {
      const { handlers, blockedHostsFor, trusted } = setup();
      expect(await handlers.get(BROWSER_POLICY_IPC.blocked)!(trusted, where)).toEqual({
        ok: true,
        hosts: [{ host: 'cdn.test', port: 443, lastSeen: 5, count: 2 }],
      });
      expect(blockedHostsFor).toHaveBeenCalledWith('pa');
    });

    it('answers an empty list for a profile the pane does not own alone', async () => {
      const { handlers, blockedHostsFor, trusted, bindings } = setup();
      delete bindings['pane-1'];
      expect(await handlers.get(BROWSER_POLICY_IPC.blocked)!(trusted, where)).toEqual({ ok: true, hosts: [] });
      bindings['pane-1'] = { workspaceId: 'ws-other', profile: 'pa' };
      expect(await handlers.get(BROWSER_POLICY_IPC.blocked)!(trusted, where)).toEqual({ ok: true, hosts: [] });
      expect(blockedHostsFor).not.toHaveBeenCalled();
    });
  });
});
