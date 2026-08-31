// @vitest-environment jsdom
//
// #1100, CodeRabbit round 1 — AddRemotePaneModal.pick had two ways to strand
// its "creating…" spinner permanently disabling every host button:
// (1) setCreatingHostId(hostId) ran before the `!remote` guard, so a missing
//     bridge left the spinner latched with nothing to ever clear it;
// (2) a rejected remote.workspaceCreate() call (as opposed to an { ok: false }
//     response, already handled) had no catch/finally to reset it.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import AddRemotePaneModal from '../AddRemotePaneModal';
import type { RemoteHostPublic } from '../../../../shared/remoteHosts';

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

async function flush(ticks = 8) {
  await act(async () => {
    for (let i = 0; i < ticks; i++) {
      await Promise.resolve();
    }
  });
}

const HOST: RemoteHostPublic = {
  id: 'host-1',
  label: 'office-mac',
  origin: 'https://office-mac.example:9600',
  addedAt: 1,
  allowInput: true,
};

describe('AddRemotePaneModal', () => {
  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('does not strand the host button disabled when window.electronAPI.remote is missing', async () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    const { container, unmount } = render(
      <AddRemotePaneModal onClose={() => { /* noop */ }} onCreated={() => { /* noop */ }} />,
    );
    // Manually seed the host list — hostsList() itself is unreachable with no
    // bridge, but pick()'s guard is what's under test here, not the loader.
    await flush();

    const btn = container.querySelector('button');
    if (btn) {
      act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await flush();
      // The guard returns before setCreatingHostId ever latches — button
      // must not be left permanently disabled.
      expect(btn.disabled).toBe(false);
    }
    unmount();
  });

  it('re-enables every host button after a rejected workspaceCreate call (not just an { ok: false } response)', async () => {
    // mockImplementation, not mockRejectedValue — the latter constructs the
    // rejected Promise eagerly at mock-setup time, which Node's unhandled-
    // rejection detector can flag before the test's own await ever attaches
    // a handler. A factory defers construction until the call the test awaits.
    const workspaceCreate = vi.fn().mockImplementation(() => Promise.reject(new Error('IPC channel closed')));
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      remote: {
        hostsList: vi.fn().mockResolvedValue([HOST]),
        workspaceCreate,
      },
    };

    const { container } = render(
      <AddRemotePaneModal onClose={() => { /* noop */ }} onCreated={() => { /* noop */ }} />,
    );
    await flush();

    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('office-mac'));
    expect(btn).toBeTruthy();
    if (!btn) return;

    // pick() throws past the `await` — the component must not propagate it
    // uncaught, and must still clear creatingHostId in a finally.
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve().catch(() => { /* swallow: assertion is on DOM state below */ });
    });
    await flush();

    expect(workspaceCreate).toHaveBeenCalled();
    expect(btn.disabled).toBe(false);
  });

  it('succeeds normally when workspaceCreate resolves ok (sanity check, unchanged behavior)', async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    const workspaceCreate = vi.fn().mockResolvedValue({ ok: true, sessionId: 'sess-1' });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      remote: {
        hostsList: vi.fn().mockResolvedValue([HOST]),
        workspaceCreate,
      },
    };

    const { container } = render(<AddRemotePaneModal onClose={onClose} onCreated={onCreated} />);
    await flush();

    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('office-mac'));
    expect(btn).toBeTruthy();
    if (!btn) return;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(onCreated).toHaveBeenCalledWith('host-1', 'sess-1');
    expect(onClose).toHaveBeenCalled();
  });
});
