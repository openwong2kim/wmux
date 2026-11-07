// @vitest-environment jsdom
//
// A pane root is its own stacking context (Pane.tsx `isolate`, #957), so a
// dialog rendered inside it paints under every pane painted after it, and a
// click on it lands on the next pane's terminal. Each dialog a pane opens
// renders into document.body instead, as BrowserPolicyDialog does.
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AddRemotePaneModal from '../../Remote/AddRemotePaneModal';
import A2aLinkDialog from '../../Remote/A2aLinkDialog';
import A2aShareDialog from '../../Remote/A2aShareDialog';
import RemoteSpawnAskDialog from '../../Remote/RemoteSpawnAskDialog';
import ContinueInAgentDialog from '../ContinueInAgentDialog';
import { useStore } from '../../../stores';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let pane: HTMLDivElement | null = null;

/** Mount `ui` inside a pane root as Pane.tsx renders one. */
function mountInPane(ui: ReactElement): HTMLDivElement {
  const host = document.createElement('div');
  host.className = 'relative isolate';
  host.setAttribute('data-panel', 'true');
  document.body.appendChild(host);
  const r = createRoot(host);
  act(() => r.render(ui));
  pane = host;
  root = r;
  return host;
}

afterEach(() => {
  const r = root;
  if (r) act(() => r.unmount());
  pane?.remove();
  root = null;
  pane = null;
  vi.unstubAllGlobals();
});

function expectOutsidePane(host: HTMLDivElement): void {
  const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
  expect(dialog, 'the dialog renders').not.toBeNull();
  expect(host.contains(dialog), 'the dialog is outside the pane root').toBe(false);
}

describe('dialogs a pane opens render above the panes', () => {
  const ws = () => useStore.getState().workspaces[0];

  it('New remote pane (and its split variants)', () => {
    vi.stubGlobal('electronAPI', { remote: { hostsList: vi.fn(async () => []) } });
    expectOutsidePane(mountInPane(<AddRemotePaneModal onClose={() => undefined} onCreated={() => undefined} />));
  });

  it('Link with a pane on another PC', () => {
    const w = ws();
    expectOutsidePane(mountInPane(
      <A2aLinkDialog local={{ kind: 'pane', workspaceId: w.id, paneId: w.rootPane.id }} onClose={() => undefined} />,
    ));
  });

  it('Share this pane with a PC', () => {
    const w = ws();
    expectOutsidePane(mountInPane(<A2aShareDialog workspaceId={w.id} paneId={w.rootPane.id} onClose={() => undefined} />));
  });

  it('Continue in another agent', () => {
    vi.stubGlobal('electronAPI', { firstRun: { agentStatus: vi.fn(async () => []) } });
    const w = ws();
    expectOutsidePane(mountInPane(
      <ContinueInAgentDialog ptyId="pty-1" workspaceId={w.id} paneId={w.rootPane.id} onClose={() => undefined} />,
    ));
  });

  it('Continue on another PC (usage limit)', () => {
    expectOutsidePane(mountInPane(
      <RemoteSpawnAskDialog place={{ hostId: 'host-1', online: true, supported: true }} pcName="office" onClose={() => undefined} />,
    ));
  });
});
