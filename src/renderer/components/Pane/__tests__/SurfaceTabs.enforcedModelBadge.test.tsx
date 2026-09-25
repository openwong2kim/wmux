// @vitest-environment jsdom
//
// The header strip's two labels — the role-enforced model badge and the
// supervision ⟳ — versus the Terminal/Chat toggle and the action cluster.
//
// Both badges used to be absolutely-positioned spans owned by Pane.tsx, offset
// from the pane's right edge by arithmetic that accounted for the action
// cluster, the corner zoom/maximize button and each other — every control they
// knew about. The chat toggle is none of those: it is a FLOW child of the same
// header, sitting immediately left of the action cluster, which is exactly
// where the offsets put the badges. On a fan-out pane in Chat view the model
// pill landed on top of the second toggle button, so the switch read
// "Terminal <model>" with the Chat label peeking out behind it; a supervised
// pane did the same thing with ⟳ and no role binding in sight.
//
// Laying both out as siblings of the toggle is what makes that
// unrepresentable, so that is what these tests pin.
//
// NOTE on what jsdom can and cannot say: there is no layout engine here, so
// every rect is 0×0 and a genuine overlap assertion is impossible. These tests
// pin the *contract* that makes overlap impossible — flow placement, DOM order,
// and the shrink/cap classes that stop a long model id from pushing the action
// cluster out of the header. The geometry itself is checked live over CDP.
import { describe, it, expect, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import SurfaceTabs, { type PaneActionsMode } from '../SurfaceTabs';
import { useStore } from '../../../stores';
import type { Surface, Workspace } from '../../../../shared/types';
import type { RoleBinding } from '../../../../shared/orchestratorRole';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function activeWs(): Workspace {
  return useStore.getState().workspaces.find((w) => w.id === useStore.getState().activeWorkspaceId)!;
}

const PTY = 'pty-s1';
const terminal: Surface = { id: 's1', ptyId: PTY, title: 'shell', shell: 'bash', cwd: '/tmp' };

interface MountOpts {
  binding?: RoleBinding;
  actionsMode?: PaneActionsMode;
  supervised?: 'armed' | 'stopped';
  surfaceType?: Surface['surfaceType'];
}

/** A pane bound to a role that really injects a model, with Chat view on —
 *  the fan-out agent pane the bug was reported against. */
function mount(opts: MountOpts = {}): void {
  const { binding = { agent: 'claude', model: 'haiku' }, actionsMode, supervised, surfaceType } = opts;
  const ws = activeWs();
  const paneId = ws.rootPane.id;
  act(() => {
    useStore.getState().setChatViewEnabled(true);
    useStore.getState().setOrchestratorRoleBinding('Builder', binding);
    useStore.getState().setPaneRole(paneId, 'Builder');
    if (supervised) useStore.getState().setSupervision(PTY, supervised, 2);
  });
  const surfaces: Surface[] = [surfaceType ? { ...terminal, surfaceType } : terminal];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(React.createElement(SurfaceTabs, {
      surfaces, activeSurfaceId: terminal.id, workspace: ws, paneId, paneActive: true,
      ...(actionsMode ? { actionsMode } : {}),
      onSelect: () => undefined, onClose: () => undefined, onSplitHorizontal: () => undefined,
      onSplitVertical: () => undefined, onAddTerminal: () => undefined, onAddBrowser: () => undefined,
    }));
  });
}

const badge = () => container.querySelector<HTMLElement>('[data-pane-enforced-model]');
const supervisionBadge = () => container.querySelector<HTMLElement>('[data-pane-supervision]');

describe('SurfaceTabs — the header badges never cover the view toggle', () => {
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    const paneId = activeWs().rootPane.id;
    act(() => {
      useStore.getState().setChatViewEnabled(false);
      useStore.getState().setPaneRole(paneId, undefined);
      useStore.getState().setOrchestratorRoleBinding('Builder', {});
      useStore.getState().clearSupervision(PTY);
    });
  });

  it('renders the model badge in the header flow, not stacked over the strip', () => {
    mount();
    expect(badge()).not.toBeNull();
    expect(badge()!.textContent).toBe('haiku');
    expect(badge()!.closest('.wmux-pane-header')).not.toBeNull();
    expect(badge()!.style.position).toBe('');
    expect(badge()!.style.right).toBe('');
    expect(badge()!.style.zIndex).toBe('');
  });

  it('keeps both toggle labels, with the badge laid out after them', () => {
    mount();
    const labels = [...container.querySelectorAll('[data-surface-view]')].map((b) => b.textContent);
    expect(labels).toHaveLength(2);
    expect(labels).not.toContain('haiku');
    for (const button of container.querySelectorAll('[data-surface-view]')) {
      expect(button.compareDocumentPosition(badge()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('yields its own width rather than pushing the action cluster out', () => {
    // The ⋮ / action cluster is shrink-0 and is the only way out of a narrow
    // pane (zoom, stash). An unbounded shrink-0 badge takes its width out of
    // the flow and shoves that cluster past the header's right edge, so the
    // badge is the one that has to be capped and shrinkable.
    mount({ binding: { agent: 'claude', model: 'claude-a-very-long-dated-model-id' } });
    const cls = badge()!.className;
    expect(cls).toContain('shrink');
    expect(cls).not.toContain('shrink-0');
    expect(cls).toContain('min-w-0');
    expect(cls).toContain('truncate');
    expect(cls).toMatch(/max-w-\[\d+px\]/);
    // The cluster keeps its place at the end of the strip regardless.
    const cluster = container.querySelector('[data-pane-actions]')!;
    expect(badge()!.compareDocumentPosition(cluster) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('carries its tooltip as an accessible name, and takes no pointer events away', () => {
    mount();
    const label = badge()!.getAttribute('title');
    expect(label).toBeTruthy();
    expect(label).toContain('haiku');
    // Same string both ways round: a screen reader gets what the pointer gets.
    expect(badge()!.getAttribute('aria-label')).toBe(label);
    // `pointer-events: none` is what used to suppress the title tooltip.
    expect(badge()!.className).not.toContain('pointer-events-none');
  });

  it.each(['overflow', 'none'] as const)('still lays the badge out in flow in %s mode', (actionsMode) => {
    mount({ actionsMode });
    expect(badge()).not.toBeNull();
    expect(badge()!.style.position).toBe('');
    expect(badge()!.closest('.wmux-pane-header')).not.toBeNull();
  });

  it('reserves the corner only when the action cluster is hidden', () => {
    // With no cluster the zoom/maximize button is drawn absolutely over the
    // strip's right end, so the strip's flow content has to stop short of it.
    mount({ actionsMode: 'none' });
    const noCluster = container.querySelector<HTMLElement>('.wmux-pane-header')!.style.paddingRight;
    act(() => root.unmount());
    container.remove();
    mount({ actionsMode: 'full' });
    const withCluster = container.querySelector<HTMLElement>('.wmux-pane-header')!.style.paddingRight;
    expect(parseInt(noCluster, 10)).toBeGreaterThan(0);
    expect(withCluster === '' || parseInt(withCluster, 10) === 0).toBe(true);
  });

  it('draws the supervision badge in flow too, after the toggle', () => {
    // Same bug class: with supervision on and NO role binding, the absolute ⟳
    // covered the Chat button all by itself.
    mount({ binding: {}, supervised: 'armed' });
    expect(badge()).toBeNull(); // model-only gate: no agent, no badge
    expect(supervisionBadge()).not.toBeNull();
    expect(supervisionBadge()!.style.position).toBe('');
    for (const button of container.querySelectorAll('[data-surface-view]')) {
      expect(button.compareDocumentPosition(supervisionBadge()!) & Node.DOCUMENT_POSITION_FOLLOWING)
        .toBeTruthy();
    }
  });

  it('draws no model badge on a browser surface, which launches no agent', () => {
    mount({ surfaceType: 'browser' });
    expect(badge()).toBeNull();
  });

  it('draws no model badge for a binding wmux would not actually apply', () => {
    // A model with no agent is stored and shown in Settings but never injected,
    // so badging it would claim a pin that the launch does not honour.
    mount({ binding: { model: 'haiku' } });
    expect(badge()).toBeNull();
  });
});
