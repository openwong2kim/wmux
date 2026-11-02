// @vitest-environment jsdom
// Pending security notices load into the store's pinned list on mount and
// arrive there live, straight from IPC: no notification row, no toast, so
// the notification policy (focus, mutes, the toast setting) never sees them.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { useSecurityNotices } from '../useSecurityNotices';
import type { SecurityNotice } from '../../../shared/securityNotice';

const notice = (id: string, timestamp: number): SecurityNotice => ({
  id, title: `title ${id}`, body: `body ${id}`, ptyId: null, timestamp,
});

let container: HTMLDivElement;
let root: Root;
let listener: ((n: SecurityNotice) => void) | null;
let unsubscribe: ReturnType<typeof vi.fn>;

function Probe() {
  useSecurityNotices();
  return null;
}

beforeEach(() => {
  listener = null;
  unsubscribe = vi.fn();
  vi.stubGlobal('electronAPI', {
    notification: {
      securityNotices: vi.fn(async () => [notice('s1', 10)]),
      onSecurityNotice: vi.fn((cb: (n: SecurityNotice) => void) => {
        listener = cb;
        return unsubscribe;
      }),
    },
  });
  useStore.setState({ securityNotices: [], notifications: [], toasts: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  container.remove();
  vi.unstubAllGlobals();
});

describe('useSecurityNotices', () => {
  it('loads the pending notices, hears new ones, and unsubscribes on unmount', async () => {
    await act(async () => root.render(createElement(Probe)));
    expect(useStore.getState().securityNotices.map((n) => n.id)).toEqual(['s1']);

    act(() => listener?.(notice('s2', 20)));
    expect(useStore.getState().securityNotices.map((n) => n.id)).toEqual(['s1', 's2']);
    // Never through the notification policy: no row and no toast.
    expect(useStore.getState().notifications).toEqual([]);
    expect(useStore.getState().toasts).toEqual([]);

    act(() => root.unmount());
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('subscribes before asking: a notice main adds after its list snapshot, heard before the list resolves, stays', async () => {
    let resolveList: () => void = () => undefined;
    // Main: the list is a snapshot taken when asked; s2 is recorded right
    // after and broadcast to whoever is subscribed at that moment.
    window.electronAPI.notification.securityNotices = vi.fn(() => {
      const snapshot = [notice('s1', 10)];
      listener?.(notice('s2', 20));
      return new Promise<SecurityNotice[]>((r) => { resolveList = () => r(snapshot); });
    });
    await act(async () => root.render(createElement(Probe)));
    expect(useStore.getState().securityNotices.map((n) => n.id)).toEqual(['s2']);
    await act(async () => resolveList());
    expect(useStore.getState().securityNotices.map((n) => n.id)).toEqual(['s1', 's2']);
    act(() => root.unmount());
  });

  it('ignores a list that resolves after unmount', async () => {
    let resolveList: () => void = () => undefined;
    window.electronAPI.notification.securityNotices = vi.fn(
      () => new Promise<SecurityNotice[]>((r) => { resolveList = () => r([notice('s1', 10)]); }),
    );
    await act(async () => root.render(createElement(Probe)));
    act(() => root.unmount());
    await act(async () => resolveList());
    expect(useStore.getState().securityNotices).toEqual([]);
  });
});
