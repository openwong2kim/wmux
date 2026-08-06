// @vitest-environment jsdom
//
// AttachRemoteModal contract (Task 7): lists registered hosts from
// window.electronAPI.remote, surfaces the add-host error string verbatim,
// lists the selected host's workspaces, and Attach dispatches
// attachRemoteWorkspace with the `${hostId}:${workspaceId}` key.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import AttachRemoteModal from '../AttachRemoteModal';
import { useStore } from '../../../stores';
import type { RemoteHostPublic, RemoteWorkspaceSummary } from '../../../../shared/remoteHosts';

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

/** Simulates typing into a controlled <input> via React's onChange path
 *  (native `.value =` bypasses React's tracked value, same trick the
 *  pre-existing tests in this file use for the masked URL field). */
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const HOST: RemoteHostPublic = {
  id: 'host-1',
  label: 'office-mac',
  origin: 'https://office-mac.example:9600',
  addedAt: 1,
  allowInput: true,
};

const WORKSPACE: RemoteWorkspaceSummary = {
  id: 'ws-abcdef12',
  name: 'my-project',
  panes: [{ sessionId: 'sess-1', shell: 'zsh', cwd: '/home' }],
};

describe('AttachRemoteModal', () => {
  let hostsList: ReturnType<typeof vi.fn>;
  let hostsAdd: ReturnType<typeof vi.fn>;
  let hostsPair: ReturnType<typeof vi.fn>;
  let hostsRemove: ReturnType<typeof vi.fn>;
  let workspacesList: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    hostsList = vi.fn().mockResolvedValue([HOST]);
    hostsAdd = vi.fn();
    hostsPair = vi.fn();
    hostsRemove = vi.fn().mockResolvedValue(true);
    workspacesList = vi.fn().mockResolvedValue({ ok: true, workspaces: [WORKSPACE] });

    (window as unknown as { electronAPI: unknown }).electronAPI = {
      remote: {
        hostsList,
        hostsAdd,
        hostsPair,
        hostsRemove,
        workspacesList,
        paneAttach: vi.fn(),
        paneDetach: vi.fn(),
        paneWrite: vi.fn(),
        onPaneMeta: vi.fn(() => () => { /* noop unsubscribe */ }),
        onPaneData: vi.fn(() => () => { /* noop unsubscribe */ }),
        onPaneExit: vi.fn(() => () => { /* noop unsubscribe */ }),
        onPaneError: vi.fn(() => () => { /* noop unsubscribe */ }),
      },
    };

    useStore.setState({ remoteWorkspaces: [], activeRemoteKey: null });
  });

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('renders hosts from window.electronAPI.remote', async () => {
    const { container, unmount } = render(<AttachRemoteModal onClose={() => { /* noop */ }} />);
    await flush();

    expect(hostsList).toHaveBeenCalled();
    expect(container.textContent).toContain('office-mac');

    unmount();
  });

  it('shows the add-host error string verbatim on failure', async () => {
    hostsAdd.mockResolvedValue({ ok: false, error: 'refused: no /api/config route' });
    const { container, unmount } = render(<AttachRemoteModal onClose={() => { /* noop */ }} />);
    await flush();

    // Paste URL is the second tab — pair-with-code is the default.
    const urlTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Paste URL')!;
    act(() => { urlTab.click(); });

    const urlInput = container.querySelector('input[type="password"]') as HTMLInputElement;
    act(() => {
      urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Simulate typing into the masked URL field via React's onChange path.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(urlInput, 'https://host.example/?token=secret');
      urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const addButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Add host')!;
    act(() => {
      addButton.click();
    });
    await flush();

    expect(hostsAdd).toHaveBeenCalled();
    expect(container.textContent).toContain('refused: no /api/config route');

    unmount();
  });

  it('selecting a host lists its workspaces', async () => {
    const { container, unmount } = render(<AttachRemoteModal onClose={() => { /* noop */ }} />);
    await flush();

    const hostButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'office-mac')!;
    act(() => {
      hostButton.click();
    });
    await flush();

    expect(workspacesList).toHaveBeenCalledWith('host-1');
    expect(container.textContent).toContain('my-project');

    unmount();
  });

  it('Attach dispatches attachRemoteWorkspace with the composed key', async () => {
    const { container, unmount } = render(<AttachRemoteModal onClose={() => { /* noop */ }} />);
    await flush();

    const hostButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'office-mac')!;
    act(() => {
      hostButton.click();
    });
    await flush();

    const attachButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Attach')!;
    act(() => {
      attachButton.click();
    });

    const remoteWorkspaces = useStore.getState().remoteWorkspaces;
    expect(remoteWorkspaces).toHaveLength(1);
    expect(remoteWorkspaces[0]).toMatchObject({
      key: 'host-1:ws-abcdef12',
      hostId: 'host-1',
      hostLabel: 'office-mac',
      workspaceId: 'ws-abcdef12',
      name: 'my-project',
    });

    unmount();
  });

  // I3(a) — hostsRemove existed on the handler/preload/types but nothing in
  // the renderer ever called it, so a dead-token host was unrecoverable
  // short of hand-editing the persisted hosts file.
  it('the remove-host button calls hostsRemove and refreshes the host list', async () => {
    const { container, unmount } = render(<AttachRemoteModal onClose={() => { /* noop */ }} />);
    await flush();

    hostsList.mockResolvedValue([]); // simulate the host being gone after removal
    const removeButton = container.querySelector('button[aria-label="Remove host"]') as HTMLButtonElement;
    expect(removeButton).toBeTruthy();
    act(() => {
      removeButton.click();
    });
    await flush();

    expect(hostsRemove).toHaveBeenCalledWith('host-1');
    expect(hostsList).toHaveBeenCalledTimes(2); // initial load + post-remove refresh

    unmount();
  });

  // m9 — a stale-response race: select host A then host B before A's
  // workspacesList resolves. A resolving last must not clobber B's list
  // while B is still the selected host.
  it('keeps the latest selected host\'s workspaces when an earlier selection resolves last', async () => {
    const HOST_B: RemoteHostPublic = { id: 'host-2', label: 'other-box', origin: 'https://other:9600', addedAt: 2, allowInput: true };
    const WORKSPACE_B: RemoteWorkspaceSummary = { id: 'ws-b', name: 'other-project', panes: [] };
    hostsList.mockResolvedValue([HOST, HOST_B]);

    let resolveA: ((v: { ok: true; workspaces: RemoteWorkspaceSummary[] }) => void) | undefined;
    const pendingA = new Promise<{ ok: true; workspaces: RemoteWorkspaceSummary[] }>((resolve) => { resolveA = resolve; });
    workspacesList.mockImplementation((hostId: string) => {
      if (hostId === 'host-1') return pendingA;
      return Promise.resolve({ ok: true, workspaces: [WORKSPACE_B] });
    });

    const { container, unmount } = render(<AttachRemoteModal onClose={() => { /* noop */ }} />);
    await flush();

    const hostAButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'office-mac')!;
    const hostBButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'other-box')!;

    act(() => { hostAButton.click(); }); // A's workspacesList hangs (pendingA)
    await flush();
    act(() => { hostBButton.click(); }); // B resolves immediately
    await flush();

    expect(container.textContent).toContain('other-project');
    expect(container.textContent).not.toContain('my-project');

    // A's stale response arrives after B already won — must not overwrite.
    act(() => { resolveA?.({ ok: true, workspaces: [WORKSPACE] }); });
    await flush();

    expect(container.textContent).toContain('other-project');
    expect(container.textContent).not.toContain('my-project');

    unmount();
  });

  // I4 — an IPC rejection (not the {ok:false} error-result path) used to
  // skip the `adding=false` reset, leaving the Add button permanently
  // disabled with no error shown.
  it('hostsAdd rejecting leaves the Add button enabled and shows a generic error', async () => {
    hostsAdd.mockRejectedValue(new Error('IPC channel closed'));
    const { container, unmount } = render(<AttachRemoteModal onClose={() => { /* noop */ }} />);
    await flush();

    const urlTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Paste URL')!;
    act(() => { urlTab.click(); });

    const urlInput = container.querySelector('input[type="password"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(urlInput, 'https://host.example/?token=secret');
      urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const addButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Add host') as HTMLButtonElement;
    act(() => {
      addButton.click();
    });
    await flush();

    expect(hostsAdd).toHaveBeenCalled();
    expect(addButton.disabled).toBe(false);
    expect(container.textContent).toContain('Could not add host');

    unmount();
  });

  describe('pair-with-code tab', () => {
    it('is the default tab and shows the host-address + pairing-code inputs', async () => {
      const { container, unmount } = render(<AttachRemoteModal onClose={() => { /* noop */ }} />);
      await flush();

      expect(container.querySelector('input[aria-label="Host address"]')).toBeTruthy();
      expect(container.querySelector('input[aria-label="Pairing code"]')).toBeTruthy();
      // The code field is deliberately NOT masked (short-lived, already
      // shown openly on the remote screen) — unlike the URL field.
      expect(container.querySelector('input[aria-label="Pairing code"]')?.getAttribute('type')).toBe('text');

      unmount();
    });

    it('switching to Paste URL and back hides/shows the respective inputs', async () => {
      const { container, unmount } = render(<AttachRemoteModal onClose={() => { /* noop */ }} />);
      await flush();

      const urlTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Paste URL')!;
      act(() => { urlTab.click(); });

      expect(container.querySelector('input[aria-label="Host address"]')).toBeFalsy();
      expect(container.querySelector('input[type="password"]')).toBeTruthy();

      const pairTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Pair with code')!;
      act(() => { pairTab.click(); });

      expect(container.querySelector('input[aria-label="Host address"]')).toBeTruthy();
      expect(container.querySelector('input[type="password"]')).toBeFalsy();

      unmount();
    });

    it('a successful pair calls hostsPair, refreshes hosts, and clears the fields', async () => {
      const PAIRED: RemoteHostPublic = { id: 'host-2', label: 'new-box', origin: 'https://new-box.example:9600', addedAt: 3, allowInput: true };
      hostsPair.mockResolvedValue({ ok: true, host: PAIRED });
      hostsList.mockResolvedValueOnce([HOST]).mockResolvedValueOnce([HOST, PAIRED]);

      const { container, unmount } = render(<AttachRemoteModal onClose={() => { /* noop */ }} />);
      await flush();

      const originInput = container.querySelector('input[aria-label="Host address"]') as HTMLInputElement;
      const codeInput = container.querySelector('input[aria-label="Pairing code"]') as HTMLInputElement;
      setInputValue(originInput, 'https://new-box.example:9600');
      setInputValue(codeInput, 'ABCD1234');

      const pairButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Pair')!;
      act(() => { pairButton.click(); });
      await flush();

      expect(hostsPair).toHaveBeenCalledWith('https://new-box.example:9600', 'ABCD1234', undefined);
      expect(hostsList).toHaveBeenCalledTimes(2); // initial load + post-pair refresh
      expect((container.querySelector('input[aria-label="Host address"]') as HTMLInputElement).value).toBe('');

      unmount();
    });

    it('an invalid-code reason renders its distinct message with the attempts count', async () => {
      hostsPair.mockResolvedValue({ ok: false, reason: 'invalid-code', attemptsLeft: 2 });
      const { container, unmount } = render(<AttachRemoteModal onClose={() => { /* noop */ }} />);
      await flush();

      const originInput = container.querySelector('input[aria-label="Host address"]') as HTMLInputElement;
      const codeInput = container.querySelector('input[aria-label="Pairing code"]') as HTMLInputElement;
      setInputValue(originInput, 'https://box.example:9600');
      setInputValue(codeInput, 'WRONGCOD');

      const pairButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Pair')!;
      act(() => { pairButton.click(); });
      await flush();

      expect(container.textContent).toContain('Wrong code — 2 attempts left');

      unmount();
    });

    it('an expired reason renders its distinct message', async () => {
      hostsPair.mockResolvedValue({ ok: false, reason: 'expired' });
      const { container, unmount } = render(<AttachRemoteModal onClose={() => { /* noop */ }} />);
      await flush();

      const originInput = container.querySelector('input[aria-label="Host address"]') as HTMLInputElement;
      const codeInput = container.querySelector('input[aria-label="Pairing code"]') as HTMLInputElement;
      setInputValue(originInput, 'https://box.example:9600');
      setInputValue(codeInput, 'DEADCODE');

      const pairButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Pair')!;
      act(() => { pairButton.click(); });
      await flush();

      expect(container.textContent).toContain('Code expired');

      unmount();
    });

    it('hostsPair rejecting leaves the Pair button enabled and shows a generic error', async () => {
      hostsPair.mockRejectedValue(new Error('IPC channel closed'));
      const { container, unmount } = render(<AttachRemoteModal onClose={() => { /* noop */ }} />);
      await flush();

      const originInput = container.querySelector('input[aria-label="Host address"]') as HTMLInputElement;
      const codeInput = container.querySelector('input[aria-label="Pairing code"]') as HTMLInputElement;
      setInputValue(originInput, 'https://box.example:9600');
      setInputValue(codeInput, 'CODECODE');

      const pairButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Pair') as HTMLButtonElement;
      act(() => { pairButton.click(); });
      await flush();

      expect(hostsPair).toHaveBeenCalled();
      expect(pairButton.disabled).toBe(false);
      expect(container.textContent).toContain('Pairing failed');

      unmount();
    });
  });
});
