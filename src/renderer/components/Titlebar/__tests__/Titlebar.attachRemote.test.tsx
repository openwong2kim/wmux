// @vitest-environment jsdom
//
// #1284 — the only UI path to "Attach remote workspace…" is the titlebar +
// button: it opens PresetPicker, whose last row swaps the dropdown for
// AttachRemoteModal. The sidebar header that used to own this button was
// removed in #418, which left a second, never-opened picker behind in
// Sidebar.tsx and made the flow look unreachable. Pin the live path so the
// control cannot silently lose its call site again.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import Titlebar from '../Titlebar';
import { useStore } from '../../../stores';

vi.mock('../../StatusBar/StatusBar', () => ({ default: () => null }));

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

let hostsList: ReturnType<typeof vi.fn>;

beforeEach(() => {
  hostsList = vi.fn().mockResolvedValue([]);
  const noopSub = vi.fn(() => () => { /* noop unsubscribe */ });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
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
  };
  // The titlebar + exists only while the sidebar is hidden and the left
  // segment is free to hold it (docked right).
  act(() => useStore.setState({ sidebarPosition: 'right', sidebarVisible: false, appRoute: 'workspaces' }));
});

function render(): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<Titlebar />));
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

describe('Titlebar + button reaches Attach remote workspace (#1284)', () => {
  it('opens the preset picker, which offers the attach-remote row', () => {
    const container = render();
    expect(findAttachRow(container)).toBeUndefined();

    const plus = container.querySelector('[data-onboarding-target="add-workspace"]') as HTMLButtonElement;
    expect(plus).not.toBeNull();
    act(() => plus.click());

    expect(findAttachRow(container)).toBeDefined();
  });

  it('swaps the picker for AttachRemoteModal when the row is chosen', async () => {
    const container = render();
    const plus = container.querySelector('[data-onboarding-target="add-workspace"]') as HTMLButtonElement;
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
