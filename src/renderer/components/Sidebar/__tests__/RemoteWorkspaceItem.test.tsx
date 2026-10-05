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

/**
 * Roots are tracked so teardown can unmount them even when a test never
 * reaches its own `unmount()` — an assertion that throws would otherwise leave
 * a live root behind, and the next test's failure would be a consequence of
 * this one rather than of its own subject.
 */
const mounted: Array<() => void> = [];

function render(ui: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  const unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  mounted.push(unmount);
  return { container, unmount };
}

/** Open the context menu on the row and return the Detach button. */
function openMenu(container: HTMLElement): HTMLButtonElement {
  const row = container.querySelector('[role="treeitem"]') as HTMLElement;
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
  // Unmount rather than wipe innerHTML: clearing the DOM under a live root
  // leaves React holding detached nodes and turns the next failure into noise.
  while (mounted.length > 0) {
    try { mounted.pop()!(); } catch { /* already unmounted by the test itself */ }
  }
});

describe('RemoteWorkspaceItem', () => {
  it.each([
    ['Shift+F10', { key: 'F10', shiftKey: true }],
    ['the Menu key', { key: 'ContextMenu' }],
  ])('opens its menu from the keyboard with %s, like a local row', (_label, init) => {
    const { container, unmount } = render(
      <RemoteWorkspaceItem workspace={WS} isActive={false} onSelect={vi.fn()} onDetach={vi.fn()} />,
    );
    const row = container.querySelector('[role="treeitem"]') as HTMLElement;
    act(() => { row.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); });
    expect(Array.from(container.querySelectorAll('button')).some((b) => /Detach/.test(b.textContent ?? ''))).toBe(true);
    unmount();
  });

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

  it('names a rejected credential in the accessible name and on a visible line', () => {
    const { container } = render(
      <RemoteWorkspaceItem workspace={{ ...WS, hostLabel: '', authRejected: true, stale: true }} isActive={false} onSelect={vi.fn()} onDetach={vi.fn()} />,
    );
    const row = container.querySelector('[role="treeitem"]') as HTMLElement;
    expect(row.getAttribute('aria-label')).toContain('the remote host no longer accepts this computer');
    expect(container.textContent).toContain('Pair again needed');
  });

  it('says a host needs HTTPS in the accessible name and on the visible host line', () => {
    const { container } = render(
      <RemoteWorkspaceItem workspace={{ ...WS, insecureTransport: true, stale: true }} isActive={false} onSelect={vi.fn()} onDetach={vi.fn()} />,
    );
    const row = container.querySelector('[role="treeitem"]') as HTMLElement;
    expect(row.getAttribute('aria-label')).toContain('needs HTTPS — re-pair over HTTPS');
    expect(container.textContent).toContain('needs HTTPS');
    expect(container.textContent).not.toContain('Pair again needed');
  });

  // Remote rows share the local list, so each one says "another machine" by
  // a server glyph on the host line, and a stale mirror is dimmed.
  it('marks the host line with a server glyph and dims only a stale row', () => {
    const live = render(<RemoteWorkspaceItem workspace={WS} isActive={false} onSelect={vi.fn()} onDetach={vi.fn()} />);
    expect(live.container.querySelector('[data-remote-host-glyph] svg')).not.toBeNull();
    expect(live.container.textContent).toContain('mac-mini');
    expect(live.container.querySelector('[data-remote-stale]')).toBeNull();
    const stale = render(<RemoteWorkspaceItem workspace={{ ...WS, stale: true }} isActive={false} onSelect={vi.fn()} onDetach={vi.fn()} />);
    expect(stale.container.querySelector('[data-remote-stale]')?.className).toContain('opacity-60');
  });
});

// Remote rows sort by their most urgent agent pane (Sidebar), so a row lifted
// for needing you must say so — dogfood showed one on top with a grey dot.
describe('RemoteWorkspaceItem — needs-you', () => {
  const pane = { sessionId: 's1', agentName: 'claude', agentStatus: 'awaiting_input' } as unknown as AttachedRemoteWorkspace['panes'][number];

  it('labels a live mirror whose agent is waiting on the user', () => {
    const { container } = render(
      <RemoteWorkspaceItem workspace={{ ...WS, panes: [pane] }} isActive={false} onSelect={vi.fn()} onDetach={vi.fn()} />,
    );
    expect(container.querySelector('[data-remote-needs-you]')).not.toBeNull();
    expect(container.querySelector('.sidebar-row-needs')).not.toBeNull();
  });

  it('says nothing for a stale mirror, whose status is frozen', () => {
    const { container } = render(
      <RemoteWorkspaceItem workspace={{ ...WS, panes: [pane], stale: true }} isActive={false} onSelect={vi.fn()} onDetach={vi.fn()} />,
    );
    expect(container.querySelector('[data-remote-needs-you]')).toBeNull();
  });
});
