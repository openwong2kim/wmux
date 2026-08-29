// @vitest-environment jsdom
//
// #1091 — add/close a pane on a remote workspace, the parity ask from #1067:
// a workspace bootstrapped on a remote host should grow/shrink like a local
// one, not sit as a fixed mirror grid. Both actions go through the store's
// real setRemoteWorkspacePanes (mergePaneSets), asserted via useStore.getState()
// rather than a re-render of this isolated component — WorkspaceCenter is the
// one that re-renders it with a fresh `workspace` prop in the real app.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import RemoteWorkspaceView from '../RemoteWorkspaceView';
import { useStore } from '../../../stores';
import type { AttachedRemoteWorkspace } from '../../../stores/slices/remoteWorkspacesSlice';

vi.mock('../RemoteMirrorTerminal', () => ({
  default: ({ attachId }: { attachId: string | null }) =>
    React.createElement('div', { 'data-attach-id': attachId ?? '' }),
}));

vi.mock('../../../hooks/useT', () => ({ useT: () => (k: string) => k }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let workspacePaneAdd: ReturnType<typeof vi.fn>;
let sessionClose: ReturnType<typeof vi.fn>;

function installElectronApi(opts: {
  addImpl?: () => Promise<unknown>;
  closeImpl?: () => Promise<unknown>;
  allowInput?: boolean;
} = {}): void {
  workspacePaneAdd = vi.fn(opts.addImpl ?? (async () => ({ ok: true as const, sessionId: 's-new' })));
  sessionClose = vi.fn(opts.closeImpl ?? (async () => ({ ok: true as const })));
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    remote: {
      paneAttach: vi.fn(async () => ({ ok: true as const, attachId: 'att-1' })),
      paneDetach: vi.fn(async () => undefined),
      hostsList: vi.fn(async () => [
        { id: 'h1', label: 'office-mac', origin: 'https://x', addedAt: 0, allowInput: opts.allowInput ?? true },
      ]),
      workspacePaneAdd,
      sessionClose,
    },
  };
}

function workspace(overrides: Partial<AttachedRemoteWorkspace> = {}): AttachedRemoteWorkspace {
  return {
    key: 'h1:ws-1',
    hostId: 'h1',
    hostLabel: 'office-mac',
    workspaceId: 'ws-1',
    name: 'Remote WS',
    panes: [{ sessionId: 's1' }],
    ...overrides,
  };
}

function render(w: AttachedRemoteWorkspace): void {
  act(() => { root.render(React.createElement(RemoteWorkspaceView, { workspace: w })); });
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // A clean slate per test — this suite asserts against the real store.
  useStore.setState({ remoteWorkspaces: [workspace()] } as never);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
});

describe('RemoteWorkspaceView — add/close a pane (#1091)', () => {
  it('add pane calls workspacePaneAdd with (hostId, workspaceId) and appends the new session to the store', async () => {
    installElectronApi();
    render(workspace());
    await settle();

    const addButton = container.querySelector('button:not([title])') as HTMLButtonElement;
    expect(addButton).not.toBeNull();
    act(() => { addButton.click(); });
    await settle();

    expect(workspacePaneAdd).toHaveBeenCalledTimes(1);
    expect(workspacePaneAdd).toHaveBeenCalledWith('h1', 'ws-1');

    const entry = useStore.getState().remoteWorkspaces.find((w) => w.key === 'h1:ws-1');
    expect(entry?.panes.map((p) => p.sessionId)).toEqual(['s1', 's-new']);
  });

  it('close pane calls sessionClose with (hostId, sessionId) and removes it from the store', async () => {
    installElectronApi();
    render(workspace({ panes: [{ sessionId: 's1' }, { sessionId: 's2' }] }));
    await settle();

    const closeButtons = container.querySelectorAll('button[title="remote.closePane"]');
    expect(closeButtons.length).toBe(2);
    act(() => { (closeButtons[0] as HTMLButtonElement).click(); });
    await settle();

    expect(sessionClose).toHaveBeenCalledTimes(1);
    expect(sessionClose).toHaveBeenCalledWith('h1', 's1');

    const entry = useStore.getState().remoteWorkspaces.find((w) => w.key === 'h1:ws-1');
    expect(entry?.panes.map((p) => p.sessionId)).toEqual(['s2']);
  });

  it('a failed add surfaces an error and does not touch the store', async () => {
    installElectronApi({ addImpl: async () => ({ ok: false as const, error: 'boom' }) });
    render(workspace());
    await settle();

    const addButton = container.querySelector('button:not([title])') as HTMLButtonElement;
    act(() => { addButton.click(); });
    await settle();

    expect(container.textContent).toContain('remote.addPaneFailed');
    const entry = useStore.getState().remoteWorkspaces.find((w) => w.key === 'h1:ws-1');
    expect(entry?.panes.map((p) => p.sessionId)).toEqual(['s1']);
  });

  it('a failed close surfaces an error and does not touch the store', async () => {
    installElectronApi({ closeImpl: async () => ({ ok: false as const, error: 'boom' }) });
    render(workspace());
    await settle();

    const closeButton = container.querySelector('button[title="remote.closePane"]') as HTMLButtonElement;
    act(() => { closeButton.click(); });
    await settle();

    expect(container.textContent).toContain('remote.closePaneFailed');
    const entry = useStore.getState().remoteWorkspaces.find((w) => w.key === 'h1:ws-1');
    expect(entry?.panes.map((p) => p.sessionId)).toEqual(['s1']);
  });

  it('read-only host (mayInput false) offers neither add nor close', async () => {
    installElectronApi({ allowInput: false });
    render(workspace());
    await settle();

    expect(container.querySelector('button[title="remote.closePane"]')).toBeNull();
    expect(container.textContent).not.toContain('remote.addPane');
  });
});
