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

function mount(workspaceId?: string): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const s = useStore.getState();
  const found = s.workspaces.find((w) => w.id === s.activeWorkspaceId)!;
  const ws = workspaceId ? { ...found, id: workspaceId } : found;
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

describe('SurfaceTabs on a shadow workspace (PC rail)', () => {
  it('hides split and new browser in the header and split, new pane and snap in the menu', () => {
    mount('shadow:h1:w1');
    for (const action of ['split-right', 'split-down', 'new-browser']) {
      expect(container.querySelector(`[data-pane-action="${action}"]`), action).toBeNull();
    }
    expect(container.querySelector('[data-pane-action="stash"]')).not.toBeNull();
    act(() => {
      container.firstElementChild!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    const keys = [...document.querySelectorAll('[data-pane-menu-action]')].map((el) => el.getAttribute('data-pane-menu-action'));
    expect(keys).not.toContain('split-right');
    expect(keys).not.toContain('split-down');
    expect(keys.some((k) => k?.startsWith('snap-'))).toBe(false);
    expect(document.querySelector('[data-pane-menu-action="new-browser"]')?.textContent).toContain('Browser (this computer)');
  });

  it('keeps every action on this computer', () => {
    mount();
    for (const action of ['split-right', 'split-down', 'new-browser']) {
      expect(container.querySelector(`[data-pane-action="${action}"]`), action).not.toBeNull();
    }
  });
});
