// @vitest-environment jsdom
//
// #1021 — the pane label is a second name for the same thing the single
// surface tab already names, so it folds away when a pane has exactly one
// tab and no user rename. This pins the three visibility states (hidden /
// user-named / multi-tab) and the affordance that makes the fold safe: the
// pane-actions menu carries a Rename item, so a label-less pane can still be
// named without the double-click target the fold removed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import SurfaceTabs from '../SurfaceTabs';
import { useStore } from '../../../stores';
import type { Surface, Workspace } from '../../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function activeWs(): Workspace {
  return useStore
    .getState()
    .workspaces.find((w) => w.id === useStore.getState().activeWorkspaceId)!;
}

function surface(id: string, title: string): Surface {
  return { id, ptyId: `pty-${id}`, title, shell: 'bash', cwd: '/tmp' };
}

function mount(surfaces: Surface[]): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const ws = activeWs();
  act(() => {
    root.render(
      React.createElement(SurfaceTabs, {
        surfaces,
        activeSurfaceId: surfaces[0]!.id,
        workspace: ws,
        paneId: ws.rootPane.id,
        paneActive: true,
        onSelect: () => undefined,
        onClose: () => undefined,
        onSplitHorizontal: () => undefined,
        onSplitVertical: () => undefined,
        onAddTerminal: () => undefined,
        onAddBrowser: () => undefined,
      }),
    );
  });
}

function paneLabelEl(): HTMLElement | null {
  return container.querySelector('[data-pane-label]');
}

describe('SurfaceTabs — single-surface pane label fold (#1021)', () => {
  beforeEach(() => {
    useStore.getState().setPaneLabel(activeWs().rootPane.id, '');
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useStore.getState().setPaneLabel(activeWs().rootPane.id, '');
  });

  it('hides the auto label when the pane has exactly one tab and no user rename', () => {
    mount([surface('s1', 'WMUX')]);
    expect(paneLabelEl()).toBeNull();
  });

  it('keeps showing a user-set label on a single-tab pane', () => {
    useStore.getState().setPaneLabel(activeWs().rootPane.id, 'build watcher');
    mount([surface('s1', 'WMUX')]);
    const el = paneLabelEl();
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe('build watcher');
  });

  it('keeps the auto label once the pane holds a second tab', () => {
    mount([surface('s1', 'WMUX'), surface('s2', 'logs')]);
    const el = paneLabelEl();
    expect(el).not.toBeNull();
    // Auto coordinate shape (w{ws}-{ordinal}, optionally with an agent slug).
    expect(el!.textContent).toMatch(/^w\d+-\d+/);
  });

  it('the pane-actions menu opens the rename editor on a label-less pane', () => {
    mount([surface('s1', 'WMUX')]);
    expect(paneLabelEl()).toBeNull();

    // Right-click the header to open the pane-actions menu.
    act(() => {
      container.firstElementChild!.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
      );
    });
    const items = Array.from(document.querySelectorAll('button, [role="menuitem"]'));
    const rename = items.find((el) => el.textContent?.includes('Rename pane'));
    expect(rename).toBeTruthy();

    act(() => {
      (rename as HTMLElement).click();
    });
    // The fold's visibility condition includes paneEditing, so the editor
    // renders even though the label span it replaces was hidden.
    expect(container.querySelector('[data-pane-label-input]')).not.toBeNull();
  });
});
