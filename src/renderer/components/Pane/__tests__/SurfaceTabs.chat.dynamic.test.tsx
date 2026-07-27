// @vitest-environment jsdom
//
// Chat View segmented control in the pane tab strip (plan PR-8).
//
// Chat is a per-surface VIEW MODE (plan D1/D6), so the control is a
// Terminal|Chat segment on the surface that already owns the ptyId — not a new
// tab class. What matters here:
//   • the Chat segment is DISABLED, with the projector's own reason string as
//     its tooltip, when the pane publishes no transcript;
//   • it enables and flips `Surface.chatMode` when the projector says available;
//   • Terminal flips it back;
//   • non-terminal surfaces (browser/diff) get no control at all — there is no
//     transcript behind them.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import SurfaceTabs from '../SurfaceTabs';
import { useStore } from '../../../stores';
import { findLeaf } from '../../../../shared/paneUtils';
import type { Surface, Workspace } from '../../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function activeWs(): Workspace {
  const s = useStore.getState();
  return s.workspaces.find((w) => w.id === s.activeWorkspaceId)!;
}

const PTY = 'pty-chat-1';
const SURFACE_ID = 'sf-chat-1';

function terminalSurface(overrides: Partial<Surface> = {}): Surface {
  return {
    id: SURFACE_ID,
    ptyId: PTY,
    title: 'Terminal',
    shell: '',
    cwd: '/repo',
    surfaceType: 'terminal',
    ...overrides,
  };
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
        activeSurfaceId: surfaces[0]?.id ?? '',
        workspace: ws,
        paneId: ws.rootPane.id,
        paneActive: true,
        onSelect: () => undefined,
        onClose: () => undefined,
        onSplitHorizontal: () => undefined,
        onSplitVertical: () => undefined,
        onAddBrowser: () => undefined,
      }),
    );
  });
}

function segment(mode: 'terminal' | 'chat'): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[data-pane-view-mode="${mode}"]`);
}

function click(mode: 'terminal' | 'chat'): void {
  const btn = segment(mode);
  expect(btn, `segment ${mode} should be present`).not.toBeNull();
  act(() => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

/** Put a real terminal surface into the store so setSurfaceChatMode can find it. */
function seedSurface(overrides: Partial<Surface> = {}): void {
  useStore.setState((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)!;
    const leaf = findLeaf(ws.rootPane, ws.rootPane.id);
    if (!leaf) return;
    leaf.surfaces.length = 0;
    leaf.surfaces.push(terminalSurface(overrides));
    leaf.activeSurfaceId = SURFACE_ID;
  });
}

function storedSurface(): Surface | undefined {
  const ws = activeWs();
  const leaf = findLeaf(ws.rootPane, ws.rootPane.id);
  return leaf?.surfaces.find((s) => s.id === SURFACE_ID);
}

beforeEach(() => {
  const state = useStore.getState();
  for (const w of [...state.workspaces]) state.removeWorkspace(w.id);
  state.addWorkspace();
  state.setPaneActionsVisible(true);
  // removeWorkspace refuses to drop the LAST workspace, so the loop above always
  // leaves one behind — and a leftover still holding a surface with this test's
  // id would be the one setSurfaceChatMode finds first. Keep exactly the fresh one.
  useStore.setState((s) => {
    s.workspaces = s.workspaces.filter((w) => w.id === s.activeWorkspaceId);
    s.chatStatus = {};
  });
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

describe('SurfaceTabs — Chat view-mode segment', () => {
  it('disables Chat and shows the unsupported-agent reason when the pane has no transcript', () => {
    useStore.getState().setChatStatus(PTY, { available: false, reason: 'not-claude' });
    seedSurface();
    mount([terminalSurface()]);

    const chat = segment('chat');
    expect(chat).not.toBeNull();
    expect(chat!.disabled).toBe(true);
    expect(chat!.getAttribute('title')).toBe(
      "Chat View needs a structured transcript; this agent doesn't publish one yet.",
    );
  });

  it('uses the first-turn reason string for a pane with no transcript path yet', () => {
    useStore.getState().setChatStatus(PTY, { available: false, reason: 'no-transcript-path' });
    seedSurface();
    mount([terminalSurface()]);

    expect(segment('chat')!.getAttribute('title')).toBe(
      "Chat View opens after this agent's first turn completes.",
    );
  });

  it('falls back to the generic reason for an unknown one (and for local mode)', () => {
    useStore.getState().setChatStatus(PTY, { available: false, reason: 'local-mode' });
    seedSurface();
    mount([terminalSurface()]);

    expect(segment('chat')!.getAttribute('title')).toBe('Chat View is unavailable for this pane.');
  });

  it('a disabled Chat segment does not flip chatMode when clicked', () => {
    useStore.getState().setChatStatus(PTY, { available: false, reason: 'not-claude' });
    seedSurface();
    mount([terminalSurface()]);

    click('chat');
    expect(storedSurface()?.chatMode).toBeUndefined();
  });

  it('enables Chat and flips chatMode when the projector says available', () => {
    useStore.getState().setChatStatus(PTY, { available: true, reason: 'ok' });
    seedSurface();
    mount([terminalSurface()]);

    const chat = segment('chat');
    expect(chat!.disabled).toBe(false);
    expect(chat!.getAttribute('title')).toBe('Chat');

    click('chat');
    expect(storedSurface()?.chatMode).toBe(true);
  });

  it('Terminal flips the view mode back', () => {
    useStore.getState().setChatStatus(PTY, { available: true, reason: 'ok' });
    seedSurface({ chatMode: true });
    mount([terminalSurface({ chatMode: true })]);

    expect(segment('chat')!.getAttribute('aria-pressed')).toBe('true');
    expect(segment('terminal')!.getAttribute('aria-pressed')).toBe('false');

    click('terminal');
    expect(storedSurface()?.chatMode).toBeUndefined();
  });

  it('renders no control for a surface that has no transcript behind it', () => {
    useStore.getState().setChatStatus(PTY, { available: true, reason: 'ok' });
    // A browser surface: real surface, no ptyId, nothing to project.
    mount([
      {
        id: 'sf-browser',
        ptyId: '',
        title: 'Browser',
        shell: '',
        cwd: '',
        surfaceType: 'browser',
      },
    ]);
    expect(container.querySelector('[data-pane-view-mode-group]')).toBeNull();
  });
});
