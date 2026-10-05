// @vitest-environment jsdom
//
// #1284 — "Attach remote workspace…" is the last row of the New workspace
// picker. The titlebar no longer carries a +, so the sidebar's header + (and,
// collapsed, the rail's, covered by MiniSidebar.attachRemote) is the path.
// Pin it so the control cannot silently lose its call site again.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import Sidebar from '../Sidebar';
import { useStore } from '../../../stores';


const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

let hostsList: ReturnType<typeof vi.fn>;

beforeEach(() => {
  hostsList = vi.fn().mockResolvedValue([]);
  const noopSub = vi.fn(() => () => { /* noop unsubscribe */ });
  // The sidebar reads more of the preload than this flow needs: anything not
  // given below resolves to an empty answer that doubles as an unsubscribe.
  const call = () => {
    const p = Promise.resolve([]);
    return Object.assign(() => undefined, { then: p.then.bind(p), catch: p.catch.bind(p), finally: p.finally.bind(p) });
  };
  const stub = (): unknown => new Proxy(call, { get: (_t, key) => (key === 'then' ? undefined : stub()) });
  const withFallback = (o: Record<string, unknown>): unknown => new Proxy(o, {
    get: (t, key: string) => (key in t ? (t[key] && typeof t[key] === 'object' && !Array.isArray(t[key]) ? withFallback(t[key] as Record<string, unknown>) : t[key]) : stub()),
  });
  (window as unknown as { electronAPI: unknown }).electronAPI = withFallback({
    platform: 'linux',
    window: {},
    remote: {
      hostsList,
      hostsAdd: vi.fn(),
      hostsPair: vi.fn(),
      hostsRemove: vi.fn(),
      workspacesList: vi.fn().mockResolvedValue({ ok: true, workspaces: [] }),
      workspaceCreate: vi.fn(),
      paneAttach: vi.fn(),
      paneDetach: vi.fn(),
      paneWrite: vi.fn(),
      onPaneMeta: noopSub,
      onPaneData: noopSub,
      onPaneExit: noopSub,
      onPaneError: noopSub,
    },
  });
  act(() => useStore.setState({ sidebarPosition: 'left', sidebarVisible: true, appRoute: 'workspaces', readOnly: false }));
});

function render(): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<Sidebar chrome="sheet" />));
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

function findAttachRow(container: HTMLElement): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Attach remote workspace'),
  );
}

describe('Sidebar header + reaches Attach remote workspace (#1284)', () => {
  it('opens the preset picker, which offers the attach-remote row', () => {
    const container = render();
    expect(findAttachRow(container)).toBeUndefined();

    const plus = container.querySelector('[aria-label="New workspace"]') as HTMLButtonElement;
    expect(plus).not.toBeNull();
    act(() => plus.click());

    expect(findAttachRow(container)).toBeDefined();
  });

  it('swaps the picker for AttachRemoteModal when the row is chosen', async () => {
    const container = render();
    const plus = container.querySelector('[aria-label="New workspace"]') as HTMLButtonElement;
    act(() => plus.click());

    const attachRow = findAttachRow(container);
    expect(attachRow).toBeDefined();
    // The picker itself reads the host list when it opens (#1323), so a bare
    // "hostsList was called" would already hold here, before the click. The
    // modal is proven by its own dialog and its own host-list load.
    const hostReadsBefore = hostsList.mock.calls.length;
    act(() => attachRow?.click());
    await act(async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });

    // The modal mounted and the dropdown it replaced is gone.
    expect(container.querySelector('.ui-dialog')?.textContent).toContain('Attach remote workspace');
    expect(hostsList).toHaveBeenCalledTimes(hostReadsBefore + 1);
    expect(findAttachRow(container)).toBeUndefined();
  });
});
