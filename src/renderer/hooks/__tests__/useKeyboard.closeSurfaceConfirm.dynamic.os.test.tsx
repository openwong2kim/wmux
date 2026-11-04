// @vitest-environment jsdom
//
// The close-tab shortcut asks before it kills the tab: a declined prompt
// leaves the tab and its PTY alone, an accepted one closes it as before. A
// held Ctrl+W auto-repeats; the repeats must not raise the confirm again.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useKeyboard } from '../useKeyboard';
import CloseTabConfirm from '../../components/Pane/CloseTabConfirm';
import { terminalRegistry } from '../useTerminal';
import { useStore } from '../../stores';
import type { Surface, Workspace } from '../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let dispose: ReturnType<typeof vi.fn>;

function pressCloseTab(repeat = false): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, key: 'w', code: 'KeyW', repeat }));
  });
}

function click(selector: string): void {
  const el = document.querySelector<HTMLButtonElement>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  act(() => el.click());
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="close-tab-confirm"]');
}

function keydown(key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
  });
}

async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  });
}

/** Stand-in xterm for the tab left active, so focus return can be observed. */
function registerTerminal(ptyId: string) {
  const term = { focus: vi.fn() };
  terminalRegistry.set(ptyId, term as never);
  return term;
}

function confirmOpen(): boolean {
  return document.querySelector('[data-testid="close-tab-confirm"]') !== null;
}

function surfaceIds(): string[] {
  const ws = useStore.getState().workspaces.find((w) => w.id === 'ws-c');
  return ws && ws.rootPane.type === 'leaf' ? ws.rootPane.surfaces.map((s) => s.id) : [];
}

beforeEach(() => {
  dispose = vi.fn();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'win32',
    window: { hide: vi.fn() },
    pty: { dispose, create: vi.fn(), write: vi.fn() },
  };
  const ws: Workspace = {
    id: 'ws-c',
    name: 'close',
    activePaneId: 'p-c',
    rootPane: {
      id: 'p-c',
      type: 'leaf',
      activeSurfaceId: 's-2',
      surfaces: [
        { id: 's-1', ptyId: 'pty-1', title: 'one', shell: 'zsh', cwd: '/tmp', surfaceType: 'terminal' },
        { id: 's-2', ptyId: 'pty-2', title: 'two', shell: 'zsh', cwd: '/tmp', surfaceType: 'terminal' },
      ],
    },
  };
  act(() => {
    useStore.setState({ workspaces: [ws], activeWorkspaceId: 'ws-c' });
    useStore.getState().setPrefixMode(false);
    useStore.getState().setAppRoute('workspaces');
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  function Harness() {
    useKeyboard();
    return React.createElement(CloseTabConfirm);
  }
  act(() => root.render(React.createElement(Harness)));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => useStore.getState().dismissCloseTab());
  terminalRegistry.delete('pty-1');
  terminalRegistry.delete('pty-2');
});

describe('close-tab shortcut confirmation', () => {
  it('keeps the tab and its PTY when the prompt is cancelled', () => {
    pressCloseTab();
    expect(confirmOpen()).toBe(true);
    click('[data-close-tab-cancel]');
    expect(confirmOpen()).toBe(false);
    expect(dispose).not.toHaveBeenCalled();
    expect(surfaceIds()).toEqual(['s-1', 's-2']);
  });

  it('closes the tab when the prompt is accepted', () => {
    pressCloseTab();
    click('[data-close-tab-confirm]');
    expect(confirmOpen()).toBe(false);
    expect(dispose).toHaveBeenCalledWith('pty-2');
    expect(surfaceIds()).toEqual(['s-1']);
  });

  it('ignores auto-repeat keydowns of a held Ctrl+W', () => {
    pressCloseTab();
    click('[data-close-tab-cancel]');
    // Still held after the cancel: the OS keeps sending repeats.
    pressCloseTab(true);
    pressCloseTab(true);
    expect(confirmOpen()).toBe(false);
    expect(surfaceIds()).toEqual(['s-1', 's-2']);
  });

  it('names the tab and labels the button as closing a tab, not a workspace', () => {
    pressCloseTab();
    const text = dialog()?.textContent ?? '';
    expect(text).toContain('Close two');
    expect(document.querySelector('[data-close-tab-confirm]')?.textContent).toBe('Close tab');
  });

  it('says a shell tab ends its shell and that programs started apart may keep running (#2555)', () => {
    pressCloseTab();
    const text = dialog()?.textContent ?? '';
    expect(text).toContain('This ends its shell and the programs running in it.');
    expect(text).toContain('may keep running');
    expect(text).not.toContain('Anything running in it will be stopped.');
  });

  function addSurface(surface: Surface): void {
    act(() => useStore.setState((st) => {
      const pane = st.workspaces[0].rootPane;
      if (pane.type === 'leaf') pane.surfaces.push(surface);
    }));
    act(() => useStore.getState().requestCloseTab({ workspaceId: 'ws-c', paneId: 'p-c', surfaceId: surface.id }));
  }

  it('keeps the general wording for a tab with no shell', () => {
    addSurface({ id: 's-3', ptyId: '', title: 'page', shell: '', cwd: '/tmp', surfaceType: 'browser' });
    const text = dialog()?.textContent ?? '';
    expect(text).toContain('Anything running in it will be stopped.');
    expect(text).not.toContain('This ends its shell');
  });

  it('closes an editor or preview tab at once, without the dialog', () => {
    addSurface({ id: 's-8', ptyId: '', title: 'notes.md', shell: '', cwd: '', surfaceType: 'editor', editorFilePath: '/tmp/notes.md' });
    expect(confirmOpen()).toBe(false);
    expect(surfaceIds()).not.toContain('s-8');
    addSurface({ id: 's-9', ptyId: '', title: 'a.png', shell: '', cwd: '', surfaceType: 'preview', previewFilePath: '/tmp/a.png' });
    expect(confirmOpen()).toBe(false);
    expect(surfaceIds()).toEqual(['s-1', 's-2']);
    expect(useStore.getState().closeTabConfirm).toBeNull();
    expect(dispose).not.toHaveBeenCalled();
  });

  it.each(['diff', 'board', 'review'] as const)('still asks before closing a %s tab', (surfaceType) => {
    addSurface({ id: 's-7', ptyId: '', title: surfaceType, shell: '', cwd: '', surfaceType });
    expect(confirmOpen()).toBe(true);
    expect(surfaceIds()).toContain('s-7');
  });

  it('treats a remote terminal this desktop minted as a shell it ends', () => {
    addSurface({ id: 's-4', ptyId: '', title: 'remote', shell: '', cwd: '', surfaceType: 'remote-terminal', remoteHostId: 'h-1', remoteSessionId: 'r-1', remoteOwned: true });
    const text = dialog()?.textContent ?? '';
    expect(text).toContain('This ends its shell and the programs running in it.');
  });

  it('says closing a view of someone else\'s remote session leaves it running', () => {
    addSurface({ id: 's-5', ptyId: '', title: 'remote', shell: '', cwd: '', surfaceType: 'remote-terminal', remoteHostId: 'h-1', remoteSessionId: 'r-2' });
    const text = dialog()?.textContent ?? '';
    expect(text).toContain('the session keeps running on the other PC');
    expect(text).not.toContain('will be stopped');
    expect(text).not.toContain('This ends its shell');
  });

  it('treats a duplicated remote tab with no session as a plain tab, not a view', () => {
    addSurface({ id: 's-6', ptyId: '', title: 'remote', shell: '', cwd: '', surfaceType: 'remote-terminal', remoteHostId: 'h-1' });
    const text = dialog()?.textContent ?? '';
    expect(text).toContain('Anything running in it will be stopped.');
    expect(text).not.toContain('the session keeps running on the other PC');
  });

  it('claims nothing stops when closing a placeholder slot', () => {
    addSurface({ id: 's-7', ptyId: '', title: 'Open in desktop', shell: '', cwd: '', surfaceType: 'placeholder' });
    const text = dialog()?.textContent ?? '';
    expect(text).toContain('Close Open in desktop');
    expect(text).not.toContain('will be stopped');
    expect(text).not.toContain('This ends its shell');
  });

  it('starts on Cancel and lets the keyboard reach Close', () => {
    pressCloseTab();
    const cancel = document.querySelector('[data-close-tab-cancel]');
    const close = document.querySelector('[data-close-tab-confirm]');
    expect(document.activeElement).toBe(cancel);
    // Shift+Tab from the first control wraps to the last one: Close.
    keydown('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(close);
  });

  it('cancels on Escape and hands focus back to the terminal', async () => {
    const term = registerTerminal('pty-2');
    pressCloseTab();
    keydown('Escape');
    expect(confirmOpen()).toBe(false);
    expect(surfaceIds()).toEqual(['s-1', 's-2']);
    await nextFrame();
    expect(term.focus).toHaveBeenCalled();
  });

  it('focuses the terminal left active after the tab closes', async () => {
    const term = registerTerminal('pty-1');
    pressCloseTab();
    click('[data-close-tab-confirm]');
    expect(surfaceIds()).toEqual(['s-1']);
    await nextFrame();
    expect(term.focus).toHaveBeenCalled();
  });
});
