import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { BROWSER_POLICY_IPC } from '../../../../shared/browserPolicy';
import {
  isTrustedMainFrameSender,
  registerBrowserPolicyIpc,
  UNTRUSTED_SENDER_ERROR,
} from '../browserPolicy.handler';

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
      write: vi.fn(async () => 1),
    };
    registerBrowserPolicyIpc({ handle: (ch: string, fn: never) => handlers.set(ch, fn) } as never, {
      getWindow: () => win,
      store,
      profileFor: () => 'pa',
      paneBindings: () => ({ 'pane-1': { workspaceId: 'ws-1', profile: 'pa' } }),
      paneWorkspace: (paneId) => (paneId === 'pane-1' ? 'ws-1' : null),
    });
    const trusted = { sender: webContents, senderFrame: mainFrame };
    return { handlers, store, trusted };
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
    expect(store.write).toHaveBeenCalledWith(expect.objectContaining({ paneId: 'pane-1' }), 'pa', true);
    expect(await handlers.get(BROWSER_POLICY_IPC.get)!(trusted, { workspaceId: 'ws-1', paneId: 'pane-1' }))
      .toMatchObject({ ok: true, state: 'missing', epoch: 0, currentProfile: 'pa' });
  });
});
