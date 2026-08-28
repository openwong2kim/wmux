// @vitest-environment jsdom
//
// The Chrome-profile submenu is only actionable on the 'chrome' backend: a
// binding is read exclusively by requireChrome/chromeRegistry.forWorkspace on
// the chrome path, so under 'builtin' or 'external' the menu would offer a
// choice that changes nothing observable. These tests pin the gate — both the
// render and the boot IPC it would otherwise fire once per workspace row.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import WorkspaceChromeProfileMenu from '../WorkspaceChromeProfileMenu';
import { useStore } from '../../../stores';

const list = vi.fn(async () => ({ profiles: ['default'], bindings: {} as Record<string, string> }));

/** Install the preload surface the menu probes for. */
function installApi(): void {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    browser: {
      chromeProfiles: {
        list,
        create: vi.fn(async () => ({ ok: true })),
        bind: vi.fn(async () => ({ ok: true })),
      },
    },
  };
}

const mounted: Array<() => void> = [];

function render(ui: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

beforeEach(() => {
  list.mockClear();
  installApi();
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('WorkspaceChromeProfileMenu — browser-backend gate', () => {
  it('renders on the chrome backend', () => {
    act(() => { useStore.getState().setBrowserBackend('chrome'); });
    const container = render(<WorkspaceChromeProfileMenu workspaceId="ws-1" flipLeft={false} />);
    expect(container.querySelector('button')).not.toBeNull();
  });

  it('renders nothing on the builtin backend', () => {
    act(() => { useStore.getState().setBrowserBackend('builtin'); });
    const container = render(<WorkspaceChromeProfileMenu workspaceId="ws-1" flipLeft={false} />);
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders nothing on the external backend', () => {
    act(() => { useStore.getState().setBrowserBackend('external'); });
    const container = render(<WorkspaceChromeProfileMenu workspaceId="ws-1" flipLeft={false} />);
    expect(container.querySelector('button')).toBeNull();
  });

  it('skips the boot profile-list IPC when the backend is not chrome', () => {
    act(() => { useStore.getState().setBrowserBackend('builtin'); });
    render(<WorkspaceChromeProfileMenu workspaceId="ws-1" flipLeft={false} />);
    // This effect runs once per rendered workspace row — it must not fire at all.
    expect(list).not.toHaveBeenCalled();
  });

  it('does fire the boot profile-list IPC on the chrome backend', () => {
    act(() => { useStore.getState().setBrowserBackend('chrome'); });
    render(<WorkspaceChromeProfileMenu workspaceId="ws-1" flipLeft={false} />);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('still hides on an older preload with no chromeProfiles surface, even on chrome', () => {
    act(() => { useStore.getState().setBrowserBackend('chrome'); });
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    const container = render(<WorkspaceChromeProfileMenu workspaceId="ws-1" flipLeft={false} />);
    expect(container.querySelector('button')).toBeNull();
  });
});
