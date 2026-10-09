// @vitest-environment jsdom
//
// PC rail, "This computer only": with another computer selected, the pane's
// new-browser action says the browser opens on this computer.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import SurfaceTabs from '../SurfaceTabs';
import { useStore } from '../../../stores';
import { DEFAULT_PC_RAIL_PERSISTED } from '../../../../shared/pcRail';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const s = useStore.getState();
  const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)!;
  act(() => {
    root.render(React.createElement(SurfaceTabs, {
      surfaces: [],
      activeSurfaceId: '',
      workspace: ws,
      paneId: ws.rootPane.id,
      paneActive: true,
      onSelect: () => undefined,
      onClose: () => undefined,
      onSplitHorizontal: () => undefined,
      onSplitVertical: () => undefined,
      onAddTerminal: () => undefined,
      onAddBrowser: () => undefined,
    }));
  });
}

const browserTitle = () => container.querySelector('[data-pane-action="new-browser"]')?.getAttribute('title');

beforeEach(() => {
  const state = useStore.getState();
  for (const w of [...state.workspaces]) state.removeWorkspace(w.id);
  state.addWorkspace();
  state.setPaneActionsVisible(true);
  useStore.setState({ pcRail: { ...DEFAULT_PC_RAIL_PERSISTED } });
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  useStore.setState({ pcRail: { ...DEFAULT_PC_RAIL_PERSISTED } });
});

describe('SurfaceTabs new browser label (PC rail)', () => {
  it('reads as today on this computer', () => {
    mount();
    expect(browserTitle()).toBe('New browser');
  });

  it('says "(this computer)" while another computer is selected', () => {
    mount();
    act(() => {
      useStore.setState({ pcRail: { ...DEFAULT_PC_RAIL_PERSISTED, activePcId: 'host-1' } });
    });
    expect(browserTitle()).toBe('Browser (this computer)');
  });
});
