// @vitest-environment jsdom
//
// RemoteWorkspaceItem's context menu. The one action it has is Detach, and the
// dismiss-on-outside-mousedown listener sits one event earlier than the
// button's own click — so "does the menu survive long enough to be clicked"
// IS the contract here, not a detail of it.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import RemoteWorkspaceItem from '../RemoteWorkspaceItem';
import type { AttachedRemoteWorkspace } from '../../../stores/slices/remoteWorkspacesSlice';

const WS: AttachedRemoteWorkspace = {
  key: 'host-1:ws-1',
  hostId: 'host-1',
  hostLabel: 'mac-mini',
  workspaceId: 'ws-1',
  name: 'my-project',
  panes: [],
};

function render(ui: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** Open the context menu on the row and return the Detach button. */
function openMenu(container: HTMLElement): HTMLButtonElement {
  const row = container.querySelector('[role="button"]') as HTMLElement;
  act(() => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
  const btn = Array.from(container.querySelectorAll('button')).find((b) =>
    /Detach/.test(b.textContent ?? ''),
  );
  if (!btn) throw new Error('Detach button not rendered');
  return btn as HTMLButtonElement;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('RemoteWorkspaceItem', () => {
  it('opens its menu on right-click', () => {
    const { container, unmount } = render(
      <RemoteWorkspaceItem workspace={WS} isActive={false} onSelect={vi.fn()} onDetach={vi.fn()} />,
    );
    expect(openMenu(container).textContent).toContain('Detach');
    unmount();
  });

  // The regression. `mousedown` fires before `click`; the document-level
  // dismiss listener unmounted the menu on that first event, so the button was
  // gone by the time its own click would have run and Detach silently did
  // nothing — which is exactly how it was reported.
  it('detaches when the button is pressed, mousedown first', () => {
    const onDetach = vi.fn();
    const { container, unmount } = render(
      <RemoteWorkspaceItem workspace={WS} isActive={false} onSelect={vi.fn()} onDetach={onDetach} />,
    );
    const btn = openMenu(container);

    act(() => {
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    // Still mounted: the dismiss listener must not have fired for a press
    // that landed inside the menu.
    expect(Array.from(container.querySelectorAll('button')).some((b) => /Detach/.test(b.textContent ?? ''))).toBe(true);

    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onDetach).toHaveBeenCalledWith('host-1:ws-1');

    unmount();
  });

  it('still dismisses on a mousedown outside the menu', () => {
    const onDetach = vi.fn();
    const { container, unmount } = render(
      <RemoteWorkspaceItem workspace={WS} isActive={false} onSelect={vi.fn()} onDetach={onDetach} />,
    );
    openMenu(container);

    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    expect(Array.from(container.querySelectorAll('button')).some((b) => /Detach/.test(b.textContent ?? ''))).toBe(false);
    expect(onDetach).not.toHaveBeenCalled();

    unmount();
  });

  it('closes on Escape without detaching', () => {
    const onDetach = vi.fn();
    const { container, unmount } = render(
      <RemoteWorkspaceItem workspace={WS} isActive={false} onSelect={vi.fn()} onDetach={onDetach} />,
    );
    openMenu(container);

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(Array.from(container.querySelectorAll('button')).some((b) => /Detach/.test(b.textContent ?? ''))).toBe(false);
    expect(onDetach).not.toHaveBeenCalled();

    unmount();
  });
});
