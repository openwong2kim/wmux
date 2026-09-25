// @vitest-environment jsdom
//
// The role-enforced model badge vs. the Terminal/Chat toggle.
//
// The badge used to be an absolutely-positioned span owned by Pane.tsx, offset
// from the right edge by arithmetic that accounted for the action cluster, the
// corner zoom/maximize button and the supervision badge — every control it knew
// about. The chat toggle is none of those: it is a FLOW child of the same
// header, sitting immediately left of the action cluster, which is exactly
// where the offset put the badge. On a fan-out pane in Chat view the model pill
// landed on top of the second toggle button, so the switch read
// "Terminal <model>" with the Chat label peeking out behind it.
//
// Laying the badge out as a sibling of the toggle is what makes that
// unrepresentable, so that is what these tests pin: it is IN the strip's flow,
// and it comes after both toggle buttons rather than over one of them.
import { describe, it, expect, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import SurfaceTabs from '../SurfaceTabs';
import { useStore } from '../../../stores';
import type { Surface, Workspace } from '../../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function activeWs(): Workspace {
  return useStore.getState().workspaces.find((w) => w.id === useStore.getState().activeWorkspaceId)!;
}

const terminal: Surface = { id: 's1', ptyId: 'pty-s1', title: 'shell', shell: 'bash', cwd: '/tmp' };

/** A pane bound to a role that really injects a model, with Chat view on —
 *  the fan-out agent pane the bug was reported against. */
function mountBoundPane(): string {
  const ws = activeWs();
  const paneId = ws.rootPane.id;
  act(() => {
    useStore.getState().setChatViewEnabled(true);
    useStore.getState().setOrchestratorRoleBinding('Builder', { agent: 'claude', model: 'haiku' });
    useStore.getState().setPaneRole(paneId, 'Builder');
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(React.createElement(SurfaceTabs, {
      surfaces: [terminal], activeSurfaceId: terminal.id, workspace: ws, paneId, paneActive: true,
      onSelect: () => undefined, onClose: () => undefined, onSplitHorizontal: () => undefined,
      onSplitVertical: () => undefined, onAddTerminal: () => undefined, onAddBrowser: () => undefined,
    }));
  });
  return paneId;
}

describe('SurfaceTabs — the model badge never covers the view toggle', () => {
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    const paneId = activeWs().rootPane.id;
    act(() => {
      useStore.getState().setChatViewEnabled(false);
      useStore.getState().setPaneRole(paneId, undefined);
      useStore.getState().setOrchestratorRoleBinding('Builder', {});
    });
  });

  it('renders the badge in the header flow, not stacked over the strip', () => {
    mountBoundPane();
    const badge = container.querySelector<HTMLElement>('[data-pane-enforced-model]');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('haiku');
    // The header is the badge's layout parent — an absolutely-positioned badge
    // was free to land anywhere, which is the whole bug.
    expect(badge!.closest('.wmux-pane-header')).not.toBeNull();
    expect(badge!.style.position).toBe('');
    expect(badge!.style.right).toBe('');
    expect(badge!.style.zIndex).toBe('');
  });

  it('keeps both toggle labels, with the badge laid out after them', () => {
    mountBoundPane();
    const labels = [...container.querySelectorAll('[data-surface-view]')].map((b) => b.textContent);
    // Two readable labels, neither of them the model name.
    expect(labels).toHaveLength(2);
    expect(labels).not.toContain('haiku');

    const badge = container.querySelector('[data-pane-enforced-model]')!;
    for (const button of container.querySelectorAll('[data-surface-view]')) {
      // DOCUMENT_POSITION_FOLLOWING: the badge comes after the button, so it
      // takes its own width beside the toggle instead of sitting on top of it.
      expect(button.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });
});
