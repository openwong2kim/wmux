// @vitest-environment jsdom
//
// Renaming a tab without the double-click: the header menu renames the tab
// that was right-clicked, the renameTab action (palette / shortcut) renames
// the active tab of the focused pane, an empty name gives the tab back to the
// shell, and Escape cancels even after the field was cleared.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import SurfaceTabs from '../SurfaceTabs';
import { useStore } from '../../../stores';
import { RENAME_ACTIVE_TAB_EVENT } from '../../../utils/commandActions';
import type { Surface, Workspace } from '../../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const renameSurface = vi.fn();
const resetSurfaceTitle = vi.fn();
let realActions: { renameSurface: unknown; resetSurfaceTitle: unknown };

function activeWs(): Workspace {
  return useStore
    .getState()
    .workspaces.find((w) => w.id === useStore.getState().activeWorkspaceId)!;
}

function surface(id: string, title: string): Surface {
  return { id, ptyId: `pty-${id}`, title, shell: 'bash', cwd: '/tmp' };
}

function mount(surfaces: Surface[], opts: { paneId?: string; activeSurfaceId?: string } = {}): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const ws = activeWs();
  act(() => {
    root.render(
      React.createElement(SurfaceTabs, {
        surfaces,
        activeSurfaceId: opts.activeSurfaceId ?? surfaces[0]!.id,
        workspace: ws,
        paneId: opts.paneId ?? ws.activePaneId,
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

function tabInput(surfaceId: string): HTMLInputElement | null {
  return container.querySelector(`[data-surface-tab-id="${surfaceId}"] input`);
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function key(input: HTMLInputElement, k: string): void {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
}

function menuItem(label: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('button, [role="menuitem"]'))
    .find((el) => el.textContent?.includes(label));
}

describe('SurfaceTabs — tab rename entry points', () => {
  beforeEach(() => {
    const st = useStore.getState();
    realActions = { renameSurface: st.renameSurface, resetSurfaceTitle: st.resetSurfaceTitle };
    useStore.setState({ renameSurface, resetSurfaceTitle } as never);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useStore.setState(realActions as never);
    renameSurface.mockReset();
    resetSurfaceTitle.mockReset();
  });

  it('right-clicking a tab offers "Rename tab" for that tab', () => {
    mount([surface('s1', 'one'), surface('s2', 'two')]);

    act(() => {
      container.querySelector('[data-surface-tab-id="s2"]')!.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
      );
    });
    const rename = menuItem('Rename tab');
    expect(rename).toBeTruthy();
    act(() => { rename!.click(); });

    const input = tabInput('s2');
    expect(input).not.toBeNull();
    expect(input!.value).toBe('two');
    expect(tabInput('s1')).toBeNull();
  });

  it('renames with a name and resets with an empty one', () => {
    mount([surface('s1', 'one')]);
    act(() => { document.dispatchEvent(new CustomEvent(RENAME_ACTIVE_TAB_EVENT)); });

    let input = tabInput('s1')!;
    typeInto(input, '  api-server ');
    key(input, 'Enter');
    expect(renameSurface).toHaveBeenCalledWith('s1', 'api-server');

    act(() => { document.dispatchEvent(new CustomEvent(RENAME_ACTIVE_TAB_EVENT)); });
    input = tabInput('s1')!;
    typeInto(input, '   ');
    key(input, 'Enter');
    expect(resetSurfaceTitle).toHaveBeenCalledWith('s1');
  });

  it('Escape cancels even after the field was cleared', () => {
    mount([surface('s1', 'one')]);
    act(() => { document.dispatchEvent(new CustomEvent(RENAME_ACTIVE_TAB_EVENT)); });

    const input = tabInput('s1')!;
    typeInto(input, '');
    // A browser blurs the field as Escape unmounts it, and that blur commits.
    // jsdom does not blur on removal, so send it inside the same act, before
    // React applies the unmount.
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    expect(tabInput('s1')).toBeNull();
    expect(resetSurfaceTitle).not.toHaveBeenCalled();
    expect(renameSurface).not.toHaveBeenCalled();
  });

  it('the renameTab action opens the active tab of the focused pane only', () => {
    mount([surface('s1', 'one'), surface('s2', 'two')], { activeSurfaceId: 's2' });
    act(() => { document.dispatchEvent(new CustomEvent(RENAME_ACTIVE_TAB_EVENT)); });
    expect(tabInput('s2')).not.toBeNull();
    expect(tabInput('s1')).toBeNull();
  });

  it('a pane that is not the focused one ignores the renameTab action', () => {
    mount([surface('s1', 'one')], { paneId: 'some-other-pane' });
    act(() => { document.dispatchEvent(new CustomEvent(RENAME_ACTIVE_TAB_EVENT)); });
    expect(tabInput('s1')).toBeNull();
  });
});
