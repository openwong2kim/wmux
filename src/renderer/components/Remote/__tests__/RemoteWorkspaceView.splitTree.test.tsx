// @vitest-environment jsdom
//
// #1091 follow-up — the flat mirror grid from #1094 is replaced by a real,
// user-controlled split tree (RemotePaneContainer, backed by the same
// react-resizable-panels primitives the local workspace uses). This suite
// proves the RENDER TREE follows split/close actions; see
// PaneContainer.moveSizes.test.tsx's own header comment for what jsdom can
// and cannot prove about the panels library (no real drag-resize here,
// by the same construction).
//
// `RemoteWorkspaceView` takes `workspace` as a plain prop — in the real app,
// `WorkspaceCenter` re-renders it with a fresh object on every store change
// (it subscribes to `remoteWorkspaces` itself). This harness has no
// WorkspaceCenter, so `rerenderFromStore` plays that part explicitly after
// each action, the same way a real store-driven re-render would.
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

class ResizeObserverStub {
  observe(): void { /* layout reflow is irrelevant under jsdom */ }
  unobserve(): void { /* no-op */ }
  disconnect(): void { /* no-op */ }
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= ResizeObserverStub;

const KEY = 'h1:ws-1';

let container: HTMLDivElement;
let root: Root;
let seq = 0;

function installElectronApi(): void {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    remote: {
      paneAttach: vi.fn(async () => ({ ok: true as const, attachId: 'att-1' })),
      paneDetach: vi.fn(async () => undefined),
      hostsList: vi.fn(async () => [
        { id: 'h1', label: 'office-mac', origin: 'https://x', addedAt: 0, allowInput: true },
      ]),
      workspacePaneAdd: vi.fn(async () => {
        seq += 1;
        return { ok: true as const, sessionId: `s-new-${seq}` };
      }),
      sessionClose: vi.fn(async () => ({ ok: true as const })),
    },
  };
}

function workspace(overrides: Partial<AttachedRemoteWorkspace> = {}): AttachedRemoteWorkspace {
  return {
    key: KEY,
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

/** Re-renders with the CURRENT store snapshot for this key — what
 *  WorkspaceCenter does on every store change in the real app. */
function rerenderFromStore(): void {
  const entry = useStore.getState().remoteWorkspaces.find((w) => w.key === KEY);
  if (!entry) throw new Error('workspace missing from store');
  render(entry);
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

function mirrorCellCount(): number {
  return container.querySelectorAll('[data-attach-id]').length;
}

beforeEach(() => {
  seq = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useStore.setState({ remoteWorkspaces: [workspace()] } as never);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
});

describe('RemoteWorkspaceView — split tree (#1091)', () => {
  it('renders a single mirror cell for a one-pane workspace, no split yet', async () => {
    installElectronApi();
    render(workspace());
    await settle();

    expect(mirrorCellCount()).toBe(1);
  });

  it('"Split right" grows the workspace and renders a second mirror cell', async () => {
    installElectronApi();
    render(workspace());
    await settle();

    const splitRight = container.querySelector('button:not([title])') as HTMLButtonElement;
    act(() => { splitRight.click(); });
    await settle();
    rerenderFromStore();
    await settle();

    expect(mirrorCellCount()).toBe(2);
    const entry = useStore.getState().remoteWorkspaces.find((w) => w.key === KEY);
    expect(entry?.panes.map((p) => p.sessionId)).toEqual(['s1', 's-new-1']);
  });

  it('"Split down" also grows to two cells, via the titled button', async () => {
    installElectronApi();
    render(workspace());
    await settle();

    const splitDown = container.querySelector('button[title="remote.splitDown"]') as HTMLButtonElement;
    act(() => { splitDown.click(); });
    await settle();
    rerenderFromStore();
    await settle();

    expect(mirrorCellCount()).toBe(2);
  });

  it('closing a pane after a split leaves exactly one mirror cell', async () => {
    installElectronApi();
    render(workspace());
    await settle();

    const splitRight = container.querySelector('button:not([title])') as HTMLButtonElement;
    act(() => { splitRight.click(); });
    await settle();
    rerenderFromStore();
    await settle();
    expect(mirrorCellCount()).toBe(2);

    const closeButtons = container.querySelectorAll('button[title="remote.closePane"]');
    expect(closeButtons.length).toBe(2);
    act(() => { (closeButtons[0] as HTMLButtonElement).click(); });
    await settle();
    rerenderFromStore();
    await settle();

    expect(mirrorCellCount()).toBe(1);
  });

  it('two splits in a row produce three mirror cells', async () => {
    installElectronApi();
    render(workspace());
    await settle();

    const splitRight = () => container.querySelector('button:not([title])') as HTMLButtonElement;
    act(() => { splitRight().click(); });
    await settle();
    rerenderFromStore();
    await settle();
    act(() => { splitRight().click(); });
    await settle();
    rerenderFromStore();
    await settle();

    expect(mirrorCellCount()).toBe(3);
  });

  it('reconciles a pane closed elsewhere (poll refresh) out of the tree', async () => {
    installElectronApi();
    render(workspace({ panes: [{ sessionId: 's1' }, { sessionId: 's2' }] }));
    await settle();
    expect(mirrorCellCount()).toBe(2);

    // Simulate the poll dropping s2 without going through this view's own
    // close action — e.g. it was closed from a different client.
    render(workspace({ panes: [{ sessionId: 's1' }] }));
    await settle();

    expect(mirrorCellCount()).toBe(1);
  });
});
