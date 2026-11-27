// @vitest-environment jsdom
//
// Closing a pane outside the tab strip (here Fleet's close) asks before it
// drops an editor's unsaved scratch text; Keep editing leaves the pane open.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import ScratchDropConfirm from '../ScratchDropConfirm';
import { setEditorDirty } from '../dirtyEditors';
import { useStore } from '../../../stores';
import { closeFleetPane } from '../../FleetView/FleetRowActions';

afterEach(() => setEditorDirty('s1', false));

describe('ScratchDropConfirm', () => {
  it('holds a pane close until Discard when an editor has scratch edits', async () => {
    const prev = useStore.getState();
    const closePane = vi.fn();
    useStore.setState({
      workspaces: [{ id: 'w1', rootPane: { type: 'leaf', id: 'p1', surfaces: [{ id: 's1', surfaceType: 'editor', ptyId: '' }] } }] as any,
      closePane,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(ScratchDropConfirm)));
      setEditorDirty('s1', true);
      const pane = { paneId: 'p1', workspaceId: 'w1' } as any;

      await act(async () => closeFleetPane(pane));
      expect(closePane).not.toHaveBeenCalled();
      await act(async () => document.querySelector<HTMLButtonElement>('[data-scratch-keep]')!.click());
      expect(closePane).not.toHaveBeenCalled();
      expect(document.querySelector('[data-testid="scratch-drop-confirm"]')).toBeNull();

      await act(async () => closeFleetPane(pane));
      await act(async () => document.querySelector<HTMLButtonElement>('[data-scratch-discard]')!.click());
      expect(closePane).toHaveBeenCalledWith('p1', 'w1');

      setEditorDirty('s1', false);
      closePane.mockClear();
      await act(async () => closeFleetPane(pane));
      expect(closePane).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
      container.remove();
      useStore.setState({ workspaces: prev.workspaces, closePane: prev.closePane });
    }
  });
});
