// @vitest-environment jsdom
//
// PaneCell's attach lifecycle. The mirror terminal itself is stubbed out —
// what is under test here is WHEN main is asked to attach and detach, which is
// what findings 2 and 8 are about, not anything xterm renders.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import RemoteWorkspaceView from '../RemoteWorkspaceView';
import type { AttachedRemoteWorkspace } from '../../../stores/slices/remoteWorkspacesSlice';

vi.mock('../RemoteMirrorTerminal', () => ({
  default: ({ attachId }: { attachId: string | null }) =>
    React.createElement('div', { 'data-attach-id': attachId ?? '' }),
}));

vi.mock('../../../hooks/useT', () => ({ useT: () => (k: string) => k }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// #1091 follow-up: RemoteWorkspaceView now renders panes through
// RemotePaneContainer's react-resizable-panels Group, which probes
// ResizeObserver on mount — same stub PaneContainer.moveSizes.test.tsx uses.
class ResizeObserverStub {
  observe(): void { /* layout reflow is irrelevant under jsdom */ }
  unobserve(): void { /* no-op */ }
  disconnect(): void { /* no-op */ }
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= ResizeObserverStub;

let container: HTMLDivElement;
let root: Root;
let paneAttach: ReturnType<typeof vi.fn>;
let paneDetach: ReturnType<typeof vi.fn>;
/** Every attachId main has handed out, so a test can tell a re-attach from a
 *  handed-back idempotent one. */
let nextAttachId: number;

function installElectronApi(opts: { attachImpl?: () => Promise<unknown> } = {}): void {
  nextAttachId = 0;
  paneAttach = vi.fn(opts.attachImpl ?? (async () => {
    nextAttachId += 1;
    return { ok: true as const, attachId: `att-${nextAttachId}` };
  }));
  paneDetach = vi.fn(async () => undefined);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    remote: {
      paneAttach,
      paneDetach,
      hostsList: vi.fn(async () => [{ id: 'h1', label: 'office-mac', origin: 'https://x', addedAt: 0, allowInput: true }]),
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
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
});

describe('RemoteWorkspaceView — PaneCell attach lifecycle', () => {
  it('attaches once per pane on mount', async () => {
    installElectronApi();
    render(workspace());
    await settle();

    expect(paneAttach).toHaveBeenCalledTimes(1);
    expect(paneAttach).toHaveBeenCalledWith('h1', 's1');
    expect(container.querySelector('[data-attach-id="att-1"]')).not.toBeNull();
  });

  // Finding 2 — the pane list is byte-identical when a slept host returns,
  // so the epoch is the only thing that can trigger a re-attach.
  it('re-attaches when attachEpoch changes even though the panes did not', async () => {
    installElectronApi();
    render(workspace({ attachEpoch: undefined }));
    await settle();
    expect(paneAttach).toHaveBeenCalledTimes(1);

    render(workspace({ attachEpoch: 1 }));
    await settle();

    expect(paneAttach).toHaveBeenCalledTimes(2);
    // The dead stream is torn down BEFORE the new one is asked for: main keys
    // attach idempotency on (sender, host, session), so the reverse order
    // would hand back the dying attachId and then kill it.
    expect(paneDetach).toHaveBeenCalledWith('att-1');
    expect(paneDetach.mock.invocationCallOrder[0])
      .toBeLessThan(paneAttach.mock.invocationCallOrder[1]);
    expect(container.querySelector('[data-attach-id="att-2"]')).not.toBeNull();
  });

  it('does not re-attach when the epoch is unchanged', async () => {
    installElectronApi();
    render(workspace({ attachEpoch: 3 }));
    await settle();
    render(workspace({ attachEpoch: 3, name: 'Renamed' }));
    await settle();

    expect(paneAttach).toHaveBeenCalledTimes(1);
    expect(paneDetach).not.toHaveBeenCalled();
  });

  // Finding 8 — panes now come and go with the poll, so a cell can disappear
  // while its attach is still in flight.
  it('detaches a pane that vanishes from the workspace', async () => {
    installElectronApi();
    render(workspace({ panes: [{ sessionId: 's1' }, { sessionId: 's2' }] }));
    await settle();
    expect(paneAttach).toHaveBeenCalledTimes(2);

    render(workspace({ panes: [{ sessionId: 's1' }] }));
    await settle();

    expect(paneDetach).toHaveBeenCalledTimes(1);
    expect(paneDetach).toHaveBeenCalledWith('att-2');
  });

  it('detaches an attachId that only lands AFTER the pane is gone', async () => {
    let releaseAttach: (v: { ok: true; attachId: string }) => void = () => { /* set below */ };
    installElectronApi({
      attachImpl: () => new Promise((resolve) => { releaseAttach = resolve as typeof releaseAttach; }),
    });
    render(workspace());
    await settle();
    expect(paneAttach).toHaveBeenCalledTimes(1);

    // The pane closes on the remote before main has answered the attach.
    render(workspace({ panes: [] }));
    await settle();
    expect(paneDetach).not.toHaveBeenCalled();

    releaseAttach({ ok: true, attachId: 'att-late' });
    await settle();

    // Without chaining, that stream would stay open in main forever.
    expect(paneDetach).toHaveBeenCalledWith('att-late');
  });

  it('surfaces an attach failure instead of leaving the cell blank', async () => {
    installElectronApi({ attachImpl: async () => ({ ok: false as const, error: 'unknown host' }) });
    render(workspace());
    await settle();

    expect(paneDetach).not.toHaveBeenCalled();
    expect(container.querySelector('[data-attach-id=""]')).not.toBeNull();
  });
});
