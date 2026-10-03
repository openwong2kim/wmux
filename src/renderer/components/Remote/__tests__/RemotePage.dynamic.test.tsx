// @vitest-environment jsdom
// The Remote rail page: a live board built from the existing web / remote /
// lanlink bridges — no new RPC, no secret or full id on screen, revoke asks
// twice, and the board re-reads on an interval while shown.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import RemotePage, { REMOTE_PAGE_POLL_MS } from '../RemotePage';

const DEVICE_ID = '9c1e77b0-4d2e-4a10-b6c7-d8e9f0a1b2c3';
let container: HTMLDivElement;
let root: Root;
let api: {
  web: Record<string, ReturnType<typeof vi.fn>>;
  remote: Record<string, ReturnType<typeof vi.fn>>;
  lanlink: Record<string, ReturnType<typeof vi.fn>>;
};

function stub(devices: unknown[]) {
  api = {
    web: {
      status: vi.fn(async () => ({
        running: true, host: '127.0.0.1', port: 7681, allowInput: false, token: 'SECRET-TOKEN',
        urls: ['http://127.0.0.1:7681/?token=SECRET-TOKEN'],
      })),
      deviceList: vi.fn(async () => ({ devices })),
      deviceRevoke: vi.fn(async () => ({ ok: true })),
    },
    remote: { hostsList: vi.fn(async () => []), hostsStatus: vi.fn(async () => ({})), hostsRemove: vi.fn() },
    lanlink: { peersList: vi.fn(async () => ({ peers: [] })), peersRemove: vi.fn() },
  };
  vi.stubGlobal('electronAPI', { platform: 'darwin', ...api });
}

async function render() {
  await act(async () => root.render(<RemotePage />));
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useStore.setState({ remoteWorkspaces: [] });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Remote page', () => {
  it('summarises the server and shows each device without secrets or full ids', async () => {
    stub([{ deviceId: DEVICE_ID, name: 'Demo iPhone', kind: 'phone', createdAt: 1, lastSeenAt: Date.now(), allowInput: true, activeNow: true }]);
    await render();
    const text = container.textContent ?? '';
    expect(container.querySelector('[data-remote-summary]')?.textContent).toBe('1 of 1 online · Web server on · This computer only');
    // This machine: the address without its token, and the share / connect buttons.
    expect(container.querySelector('[data-remote-address]')?.textContent).toBe('http://127.0.0.1:7681');
    expect(container.querySelector('[data-remote-machine] [data-remote-add-host]')).not.toBeNull();
    expect(container.querySelector('[data-remote-activity]')?.textContent).toContain('Paired Demo iPhone');
    expect(text).toContain('Demo iPhone');
    expect(text).toContain('#9c1e77');
    expect(text).toContain('Can type once input is on');
    expect(text).not.toContain(DEVICE_ID);
    expect(text).not.toContain('SECRET-TOKEN');
    expect(container.querySelector('[data-remote-entry="phone"][data-live="true"] .wmux-remote-live')).not.toBeNull();
  });

  it('Escape returns to Workspaces, after cancelling an open confirmation', async () => {
    stub([{ deviceId: DEVICE_ID, name: 'Old laptop', kind: 'computer', createdAt: 1, lastSeenAt: 1, allowInput: false }]);
    useStore.getState().setAppRoute('remote');
    await render();
    const escape = (from: Element) => act(() => {
      from.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    const button = () => container.querySelector<HTMLButtonElement>('[data-remote-remove="computer"]')!;
    act(() => button().click());
    expect(button().textContent).toBe('Revoke for good?');
    escape(button());
    expect(button().textContent).not.toBe('Revoke for good?');
    expect(useStore.getState().appRoute).toBe('remote');
    escape(button());
    expect(useStore.getState().appRoute).toBe('workspaces');
    expect(api.web.deviceRevoke).not.toHaveBeenCalled();
  });

  it('Escape leaves the page alone while the palette or notifications are open', async () => {
    stub([]);
    useStore.getState().setAppRoute('remote');
    await render();
    const title = container.querySelector('#remote-page-title')!;
    for (const over of [{ commandPaletteVisible: true }, { notificationPanelVisible: true }]) {
      useStore.setState({ commandPaletteVisible: false, notificationPanelVisible: false, ...over });
      act(() => { title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
      expect(useStore.getState().appRoute).toBe('remote');
    }
    useStore.setState({ commandPaletteVisible: false, notificationPanelVisible: false });
    useStore.getState().setAppRoute('workspaces');
  });

  it('revokes only on the second click', async () => {
    stub([{ deviceId: DEVICE_ID, name: 'Old laptop', kind: 'computer', createdAt: 1, lastSeenAt: 1, allowInput: false }]);
    await render();
    const button = () => container.querySelector<HTMLButtonElement>('[data-remote-remove="computer"]')!;
    act(() => button().click());
    expect(api.web.deviceRevoke).not.toHaveBeenCalled();
    expect(button().textContent).toBe('Revoke for good?');
    await act(async () => { button().click(); });
    expect(api.web.deviceRevoke).toHaveBeenCalledWith(DEVICE_ID);
  });

  it('explains how to connect something when nothing is, and re-reads on an interval', async () => {
    stub([]);
    await render();
    expect(container.querySelector('[data-remote-empty]')?.textContent).toContain('Nothing is connected yet');
    // The machine panel stays beside an empty board; no activity, no section.
    expect(container.querySelector('[data-remote-machine]')).not.toBeNull();
    expect(container.querySelector('[data-remote-activity]')).toBeNull();
    expect(api.web.deviceList).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(REMOTE_PAGE_POLL_MS); });
    expect(api.web.deviceList).toHaveBeenCalledTimes(2);
  });

  it('lists online devices before offline ones', async () => {
    stub([
      { deviceId: 'off-device-1111', name: 'Old laptop', kind: 'computer', createdAt: 1, lastSeenAt: 5, allowInput: false },
      { deviceId: 'on-device-2222', name: 'Phone', kind: 'phone', createdAt: 2, lastSeenAt: 1, allowInput: false, activeNow: true },
    ]);
    await render();
    const names = [...container.querySelectorAll('.wmux-remote-card-name')].map((el) => el.textContent);
    expect(names).toEqual(['Phone', 'Old laptop']);
    expect(container.querySelector('[data-remote-entry="computer"]')?.hasAttribute('data-live')).toBe(false);
  });
});
