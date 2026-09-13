// @vitest-environment jsdom
//
// #1284 — with the sidebar collapsed, the titlebar + is clipped by its 48px
// segment, so the rail's own + is the only UI path to PresetPicker and its
// "Attach remote workspace…" row. It used to call addWorkspace() directly.
// Pin: the rail + opens the picker (not a new workspace), the picker flies
// out beside the rail instead of inside it, and the attach row mounts
// AttachRemoteModal.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import MiniSidebar from '../MiniSidebar';
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
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'linux',
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
  act(() => useStore.setState({ sidebarPosition: 'left', sidebarVisible: false }));
});

function render(): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<MiniSidebar />));
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

function railPlus(container: HTMLElement): HTMLButtonElement {
  return container.querySelector('[data-mini-add-workspace]') as HTMLButtonElement;
}

function findAttachRow(container: HTMLElement): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Attach remote workspace'),
  );
}

describe('collapsed rail + reaches Attach remote workspace (#1284)', () => {
  it('opens the preset picker beside the rail instead of adding a workspace', () => {
    const container = render();
    const before = useStore.getState().workspaces.length;
    const plus = railPlus(container);
    expect(plus).not.toBeNull();
    plus.getBoundingClientRect = () =>
      ({ left: 0, right: 48, top: 36, bottom: 76, width: 48, height: 40, x: 0, y: 36, toJSON: () => ({}) }) as DOMRect;

    act(() => plus.click());

    expect(useStore.getState().workspaces.length).toBe(before);
    const attachRow = findAttachRow(container);
    expect(attachRow).toBeDefined();
    const menu = attachRow?.parentElement as HTMLElement;
    expect(menu.className).toContain('fixed');
    expect(menu.style.left).toBe('52px');
    expect(menu.style.top).toBe('36px');
  });

  it('swaps the picker for AttachRemoteModal when the attach row is chosen', async () => {
    const container = render();
    act(() => railPlus(container).click());

    const attachRow = findAttachRow(container);
    expect(attachRow).toBeDefined();
    act(() => attachRow?.click());
    await act(async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });

    expect(hostsList).toHaveBeenCalled();
    expect(findAttachRow(container)).toBeUndefined();
  });
});
