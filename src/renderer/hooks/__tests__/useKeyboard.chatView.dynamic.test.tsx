// @vitest-environment jsdom
//
// Cmd/Ctrl+Shift+J — the Terminal ⇄ Chat view-mode chord (plan PR-8).
//
// Mounts the REAL useKeyboard against the REAL store and dispatches REAL
// KeyboardEvents, same shape as useKeyboard.zoom.dynamic.test.tsx. The chord is
// gated exactly like the SurfaceTabs segment: it cannot strand a pane on an
// empty Chat view that its agent will never be able to fill.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useKeyboard } from '../useKeyboard';
import { useStore } from '../../stores';
import { findLeaf } from '../../../shared/paneUtils';
import type { Surface, Workspace } from '../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const PTY = 'pty-chord-1';
const SURFACE_ID = 'sf-chord-1';

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  function Harness(): null {
    useKeyboard();
    return null;
  }
  act(() => { root.render(React.createElement(Harness)); });
}

function pressChord(): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'J',
        code: 'KeyJ',
        ctrlKey: true,
        shiftKey: true,
      }),
    );
  });
}

function activeWs(): Workspace {
  const s = useStore.getState();
  return s.workspaces.find((w) => w.id === s.activeWorkspaceId)!;
}

function storedSurface(): Surface | undefined {
  const ws = activeWs();
  const leaf = findLeaf(ws.rootPane, ws.activePaneId);
  return leaf?.surfaces.find((s) => s.id === SURFACE_ID);
}

function seed(overrides: Partial<Surface> = {}): void {
  useStore.setState((s) => {
    // removeWorkspace refuses to drop the last workspace, so keep exactly the
    // active one — a leftover holding the same surface id would be found first.
    s.workspaces = s.workspaces.filter((w) => w.id === s.activeWorkspaceId);
    s.chatStatus = {};
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)!;
    const leaf = findLeaf(ws.rootPane, ws.activePaneId);
    if (!leaf) return;
    leaf.surfaces.length = 0;
    leaf.surfaces.push({
      id: SURFACE_ID,
      ptyId: PTY,
      title: 'Terminal',
      shell: '',
      cwd: '/repo',
      surfaceType: 'terminal',
      ...overrides,
    });
    leaf.activeSurfaceId = SURFACE_ID;
  });
}

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'win32',
    window: { hide: vi.fn() },
    pty: { dispose: vi.fn(), create: vi.fn(), write: vi.fn() },
  };
  const state = useStore.getState();
  for (const w of [...state.workspaces]) state.removeWorkspace(w.id);
  state.addWorkspace();
  act(() => { useStore.getState().setPrefixMode(false); });
  mount();
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

describe('Cmd/Ctrl+Shift+J — Terminal ⇄ Chat', () => {
  it('turns Chat on for a pane whose projector reports available', () => {
    seed();
    act(() => { useStore.getState().setChatStatus(PTY, { available: true, reason: 'ok' }); });

    pressChord();
    expect(storedSurface()?.chatMode).toBe(true);
  });

  it('toggles back off on a second press', () => {
    seed();
    act(() => { useStore.getState().setChatStatus(PTY, { available: true, reason: 'ok' }); });

    pressChord();
    pressChord();
    expect(storedSurface()?.chatMode).toBeUndefined();
  });

  it('does nothing when the pane publishes no transcript', () => {
    seed();
    act(() => { useStore.getState().setChatStatus(PTY, { available: false, reason: 'not-claude' }); });

    pressChord();
    expect(storedSurface()?.chatMode).toBeUndefined();
  });

  it('does nothing when the projector has not answered yet', () => {
    seed();
    pressChord();
    expect(storedSurface()?.chatMode).toBeUndefined();
  });

  it('still turns Chat OFF even after availability disappears (the escape hatch)', () => {
    seed({ chatMode: true });
    act(() => { useStore.getState().setChatStatus(PTY, { available: false, reason: 'unreadable' }); });
    // The status flip already forces it off (A9③); re-arm and prove the chord
    // itself never refuses the off direction.
    useStore.setState((s) => {
      const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)!;
      const leaf = findLeaf(ws.rootPane, ws.activePaneId);
      const sf = leaf?.surfaces.find((x) => x.id === SURFACE_ID);
      if (sf) sf.chatMode = true;
    });

    pressChord();
    expect(storedSurface()?.chatMode).toBeUndefined();
  });
});
