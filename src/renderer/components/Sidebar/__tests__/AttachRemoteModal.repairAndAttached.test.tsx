// @vitest-environment jsdom
//
// Two owner-reported gaps in the attach modal:
//   - a host that stopped accepting this computer showed the raw
//     "listWorkspaces failed: HTTP 401" with no way forward. It must say what
//     happened and offer one click that drops the stale credential and lands on
//     "Pair with code" for that host;
//   - the workspace list gave no sign of what was already attached, closed on
//     every Attach, and said "1 panes".

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

async function flush(ticks = 12) {
  await act(async () => {
    for (let i = 0; i < ticks; i++) await Promise.resolve();
  });
}

function button(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text);
}

const HOST: RemoteHostPublic = {
  id: 'host-1',
  label: 'office-mac',
  origin: 'https://office-mac.example:9600',
  addedAt: 1,
  allowInput: true,
};

const WS_A: RemoteWorkspaceSummary = { id: 'ws-a', name: 'alpha', panes: [{ sessionId: 's-1' }] };
const WS_B: RemoteWorkspaceSummary = {
  id: 'ws-b',
  name: 'beta',
  panes: [{ sessionId: 's-2' }, { sessionId: 's-3' }],
};

describe('AttachRemoteModal — re-pair and attached state', () => {
  let hostsList: ReturnType<typeof vi.fn>;
  let hostsRemove: ReturnType<typeof vi.fn>;
  let workspacesList: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    hostsList = vi.fn().mockResolvedValue([HOST]);
    hostsRemove = vi.fn().mockResolvedValue(true);
    workspacesList = vi.fn().mockResolvedValue({ ok: true, workspaces: [WS_A, WS_B] });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      remote: {
        hostsList,
        hostsAdd: vi.fn(),
        hostsPair: vi.fn(),
        hostsRemove,
        workspacesList,
        workspaceCreate: vi.fn(),
        attachmentsAdd: vi.fn().mockResolvedValue(true),
        attachmentsRemove: vi.fn().mockResolvedValue(true),
      },
    };
    useStore.setState({ remoteWorkspaces: [], activeRemoteKey: null });
  });

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  async function openHost() {
    const view = render(<AttachRemoteModal onClose={() => { /* noop */ }} />);
    await flush();
    act(() => { button(view.container, 'office-mac')!.click(); });
    await flush();
    return view;
  }

  it('a rejected credential says to pair again instead of showing the raw status', async () => {
    workspacesList.mockResolvedValue({
      ok: false,
      error: 'listWorkspaces failed: HTTP 401',
      reason: 'auth-rejected',
    });
    const { container, unmount } = await openHost();

    expect(container.textContent).toContain('office-mac no longer accepts this computer');
    expect(container.textContent).not.toContain('HTTP 401');
    expect(button(container, 'Pair again')).toBeDefined();
    unmount();
  });

  it('"Pair again" only pre-fills Pair with code — the host is not removed', async () => {
    workspacesList.mockResolvedValue({ ok: false, error: 'x', reason: 'auth-rejected' });
    const { container, unmount } = await openHost();

    act(() => { button(container, 'Pair again')!.click(); });
    await flush();

    expect(hostsRemove).not.toHaveBeenCalled();
    const address = container.querySelector('input[aria-label="Host address"]') as HTMLInputElement;
    expect(address.value).toBe(HOST.origin);
    // Focus lands on the code field once the pair form has rendered.
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Pairing code');
    unmount();
  });

  it('pairing after "Pair again" replaces the credential of that same host', async () => {
    workspacesList.mockResolvedValue({ ok: false, error: 'x', reason: 'auth-rejected' });
    const hostsPair = (window as unknown as { electronAPI: { remote: { hostsPair: ReturnType<typeof vi.fn> } } })
      .electronAPI.remote.hostsPair;
    hostsPair.mockResolvedValue({ ok: true, host: HOST });
    const { container, unmount } = await openHost();
    act(() => { button(container, 'Pair again')!.click(); });
    await flush();

    const code = container.querySelector('input[aria-label="Pairing code"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setter.call(code, 'ABCD1234'); code.dispatchEvent(new Event('input', { bubbles: true })); });
    workspacesList.mockResolvedValue({ ok: true, workspaces: [WS_A] });
    act(() => { button(container, 'Pair')!.click(); });
    await flush();

    expect(hostsPair).toHaveBeenCalledWith(HOST.origin, 'ABCD1234', HOST.label, 'host-1');
    expect(hostsRemove).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('no longer accepts');
    unmount();
  });

  it('opened for a repair, it pre-fills without removing anything', async () => {
    const { container, unmount } = render(
      <AttachRemoteModal onClose={() => { /* noop */ }} repairHostId="host-1" />,
    );
    await flush();

    expect(hostsRemove).not.toHaveBeenCalled();
    const address = container.querySelector('input[aria-label="Host address"]') as HTMLInputElement;
    expect(address.value).toBe(HOST.origin);
    unmount();
  });

  it('a late 401 from a create on another host does not flag the host now selected', async () => {
    const OTHER: RemoteHostPublic = { ...HOST, id: 'host-2', label: 'lab-box', origin: 'https://lab:9600' };
    hostsList.mockResolvedValue([HOST, OTHER]);
    let resolveCreate!: (v: unknown) => void;
    const workspaceCreate = (window as unknown as { electronAPI: { remote: { workspaceCreate: ReturnType<typeof vi.fn> } } })
      .electronAPI.remote.workspaceCreate;
    workspaceCreate.mockReturnValue(new Promise((r) => { resolveCreate = r; }));
    const { container, unmount } = await openHost();

    act(() => { button(container, 'New workspace on this host')!.click(); });
    await flush();
    act(() => { button(container, 'lab-box')!.click(); });
    await flush();
    await act(async () => { resolveCreate({ ok: false, error: 'x', reason: 'auth-rejected' }); });
    await flush();

    expect(container.textContent).not.toContain('no longer accepts');
    unmount();
  });

  it('falls back to a generic name when the host has no label', async () => {
    hostsList.mockResolvedValue([{ ...HOST, label: '' }]);
    workspacesList.mockResolvedValue({ ok: false, error: 'x', reason: 'auth-rejected' });
    const view = render(<AttachRemoteModal onClose={() => { /* noop */ }} repairHostId="host-1" />);
    await flush();
    expect(view.container.textContent).toContain('the remote host no longer accepts this computer');
    view.unmount();
  });

  it('a workspace already tracked for a remote pane counts as attached', async () => {
    useStore.setState({
      remoteWorkspaces: [{
        key: 'host-1:ws-b', hostId: 'host-1', hostLabel: 'office-mac',
        workspaceId: 'ws-b', name: 'beta', panes: [], ephemeral: true,
      }],
    });
    const { container, unmount } = await openHost();
    const beta = Array.from(container.querySelectorAll('.ui-row')).find((r) => r.textContent?.includes('beta')) as HTMLElement;
    expect(beta.textContent).toContain('Attached');
    expect(button(beta, 'Attach')).toBeUndefined();
    unmount();
  });

  it('marks workspaces that are already attached instead of offering Attach', async () => {
    useStore.setState({
      remoteWorkspaces: [{
        key: 'host-1:ws-a', hostId: 'host-1', hostLabel: 'office-mac',
        workspaceId: 'ws-a', name: 'alpha', panes: [],
      }],
    });
    const { container, unmount } = await openHost();

    const rows = Array.from(container.querySelectorAll('.ui-row'));
    const alpha = rows.find((r) => r.textContent?.includes('alpha'))!;
    const beta = rows.find((r) => r.textContent?.includes('beta'))!;
    expect(alpha.textContent).toContain('Attached');
    expect(button(alpha as HTMLElement, 'Attach')).toBeUndefined();
    expect(button(beta as HTMLElement, 'Attach')).toBeDefined();
    unmount();
  });

  it('stays open after Attach and flips the row to Attached in place', async () => {
    const onClose = vi.fn();
    const view = render(<AttachRemoteModal onClose={onClose} />);
    await flush();
    act(() => { button(view.container, 'office-mac')!.click(); });
    await flush();

    const rowOf = (name: string) =>
      Array.from(view.container.querySelectorAll('.ui-row')).find((r) => r.textContent?.includes(name)) as HTMLElement;
    act(() => { button(rowOf('alpha'), 'Attach')!.click(); });
    await flush();

    expect(onClose).not.toHaveBeenCalled();
    expect(rowOf('alpha').textContent).toContain('Attached');
    // The next one is still one click away.
    act(() => { button(rowOf('beta'), 'Attach')!.click(); });
    await flush();
    expect(useStore.getState().remoteWorkspaces.map((w) => w.key).sort()).toEqual(['host-1:ws-a', 'host-1:ws-b']);
    view.unmount();
  });

  it('pluralises the pane count', async () => {
    const { container, unmount } = await openHost();
    expect(container.textContent).toContain('1 pane');
    expect(container.textContent).not.toContain('1 panes');
    expect(container.textContent).toContain('2 panes');
    unmount();
  });
});
