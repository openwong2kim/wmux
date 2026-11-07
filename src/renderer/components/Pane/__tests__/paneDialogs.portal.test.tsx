// @vitest-environment jsdom
//
// A pane root is its own stacking context (Pane.tsx `isolate`, #957), so a
// dialog rendered inside it paints under every pane painted after it, and a
// click on it lands on the next pane's terminal. A ui/Dialog a pane opens
// renders into the dialog host PaneContainer keeps beside the panes: out of
// the pane, but still inside the workspace slot that hides it.
import React, { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../Pane', async () => {
  const { default: Dialog, DialogHeader } = await import('../../ui/Dialog');
  return {
    // A pane root as Pane.tsx renders one; the first leaf has a dialog open.
    default: ({ pane, workspace }: { pane: { id: string }; workspace: { rootPane: { children?: Array<{ id: string }> } } }) =>
      React.createElement('div', { 'data-leaf': pane.id, className: 'relative isolate' },
        workspace.rootPane.children?.[0]?.id === pane.id
          ? React.createElement(Dialog, { onClose: () => undefined },
            React.createElement(DialogHeader, { title: 'Opened from a pane' }))
          : null),
  };
});

import PaneContainer from '../PaneContainer';
import { DialogHost } from '../../ui/dialogHost';
import AddRemotePaneModal from '../../Remote/AddRemotePaneModal';
import A2aLinkDialog from '../../Remote/A2aLinkDialog';
import A2aShareDialog from '../../Remote/A2aShareDialog';
import RemoteSpawnAskDialog from '../../Remote/RemoteSpawnAskDialog';
import ContinueInAgentDialog from '../ContinueInAgentDialog';
import { useStore } from '../../../stores';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= class {
  observe(): void { /* layout is irrelevant under jsdom */ }
  unobserve(): void { /* no-op */ }
  disconnect(): void { /* no-op */ }
};

let root: Root | null = null;
let slot: HTMLDivElement | null = null;

/** Mount `ui` in a stand-in for the workspace slot that hides it. */
function mount(ui: ReactElement): HTMLDivElement {
  const host = document.createElement('div');
  host.setAttribute('data-slot', '');
  document.body.appendChild(host);
  const r = createRoot(host);
  act(() => r.render(ui));
  slot = host;
  root = r;
  return host;
}

afterEach(() => {
  const r = root;
  if (r) act(() => r.unmount());
  slot?.remove();
  root = null;
  slot = null;
  vi.unstubAllGlobals();
});

const ws = () => {
  const s = useStore.getState();
  return s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? s.workspaces[0];
};

describe('PaneContainer keeps a dialog host beside the panes', () => {
  it('a dialog opened inside a pane renders outside every pane root, inside the workspace slot', () => {
    const before = ws();
    useStore.getState().splitPane(before.rootPane.id, 'horizontal', before.id);
    const w = ws();
    const s = mount(<PaneContainer pane={w.rootPane} workspace={w} />);
    const dialog = s.querySelector('[role="dialog"]');
    expect(dialog, 'the dialog renders inside the workspace slot').not.toBeNull();
    const leaves = s.querySelectorAll('[data-leaf]');
    expect(leaves.length).toBe(2);
    for (const leaf of leaves) {
      expect(leaf.contains(dialog), `outside pane ${leaf.getAttribute('data-leaf')}`).toBe(false);
    }
    // One host for the whole tree, not one per split, and its own stacking
    // context at the panes' level: a rail page that covers the panes covers it.
    const hosts = s.querySelectorAll<HTMLElement>('[data-dialog-host]');
    expect(hosts).toHaveLength(1);
    expect(hosts[0].style.isolation).toBe('isolate');
  });
});

describe('the dialogs a pane opens use that host', () => {
  /** Mount `ui` inside a pane root, below a dialog host, as PaneContainer does. */
  function expectOutsidePane(ui: ReactElement): void {
    const s = mount(
      <DialogHost>
        <div data-leaf="p" className="relative isolate">{ui}</div>
      </DialogHost>,
    );
    const dialog = s.querySelector('[role="dialog"], [role="alertdialog"]');
    expect(dialog, 'the dialog renders').not.toBeNull();
    expect(s.querySelector('[data-leaf]')?.contains(dialog), 'outside the pane root').toBe(false);
    expect(s.querySelector('[data-dialog-host]')?.contains(dialog), 'in the dialog host').toBe(true);
  }

  it('New remote pane (and its split variants)', () => {
    vi.stubGlobal('electronAPI', { remote: { hostsList: vi.fn(async () => []) } });
    expectOutsidePane(<AddRemotePaneModal onClose={() => undefined} onCreated={() => undefined} />);
  });

  it('Link with a pane on another PC', () => {
    const w = ws();
    expectOutsidePane(<A2aLinkDialog local={{ kind: 'pane', workspaceId: w.id, paneId: w.rootPane.id }} onClose={() => undefined} />);
  });

  it('Share this pane with a PC', () => {
    const w = ws();
    expectOutsidePane(<A2aShareDialog workspaceId={w.id} paneId={w.rootPane.id} onClose={() => undefined} />);
  });

  it('Continue in another agent', () => {
    vi.stubGlobal('electronAPI', { firstRun: { agentStatus: vi.fn(async () => []) } });
    const w = ws();
    expectOutsidePane(<ContinueInAgentDialog ptyId="pty-1" workspaceId={w.id} paneId={w.rootPane.id} onClose={() => undefined} />);
  });

  it('Continue on another PC (usage limit)', () => {
    expectOutsidePane(<RemoteSpawnAskDialog place={{ hostId: 'host-1', online: true, supported: true }} pcName="office" onClose={() => undefined} />);
  });
});
