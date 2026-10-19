// @vitest-environment jsdom
//
// Mention-an-agent shortcut: ⌘⇧2 on macOS, F2 on Windows / Linux. It opens the
// picker only while an agent pane (or Chat view) has focus; in a plain shell
// the key must reach the terminal untouched — F2 is mc's, htop's and vim's.
// Drives the real hook and store with real KeyboardEvents.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createWorkspace } from '../../../shared/types';
import { defaultBindings, effectiveBindings, resolveShortcut } from '../../../shared/keymap';
import { useStore } from '../../stores';
import { useKeyboard } from '../useKeyboard';
import { OPEN_MENTION_PICKER_EVENT } from '../../utils/agentMentionInsert';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let opened = 0;
const onOpen = (): void => { opened += 1; };

function mount(platform: NodeJS.Platform): void {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform,
    window: { hide: vi.fn() },
    pty: { dispose: vi.fn(), create: vi.fn(), write: vi.fn() },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  function Harness(): null {
    useKeyboard();
    return null;
  }
  act(() => { root.render(React.createElement(Harness)); });
}

function press(init: KeyboardEventInit, target: EventTarget = window): { event: KeyboardEvent; reachedTarget: boolean } {
  let reachedTarget = false;
  const later = (): void => { reachedTarget = true; };
  window.addEventListener('keydown', later);
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  window.removeEventListener('keydown', later);
  return { event, reachedTarget };
}

/** One workspace whose focused pane is an agent (or a shell when `agent` is false). */
function seed(agent: boolean, overrides = {}): void {
  const ws = createWorkspace('one');
  const leaf = ws.rootPane as { surfaces: unknown[]; activeSurfaceId: string; id: string };
  leaf.surfaces = [{ id: 'surf-1', ptyId: 'pty-1', title: 'zsh', shell: 'zsh', cwd: '/', surfaceType: 'terminal' }];
  leaf.activeSurfaceId = 'surf-1';
  act(() => {
    useStore.setState((state) => {
      state.workspaces = [ws];
      state.activeWorkspaceId = ws.id;
      state.shortcutOverrides = overrides;
      state.surfaceAgent = agent ? { 'pty-1': { name: 'Claude Code', status: 'idle' } } : {};
      state.toasts = [];
      state.setPrefixMode(false);
    });
  });
}

beforeEach(() => {
  opened = 0;
  document.addEventListener(OPEN_MENTION_PICKER_EVENT, onOpen);
});

afterEach(() => {
  document.removeEventListener(OPEN_MENTION_PICKER_EVENT, onOpen);
  if (root) act(() => root.unmount());
  container?.remove();
});

describe('mentionAgent default bindings', () => {
  it('is ⌘⇧2 on macOS and F2 on Windows / Linux', () => {
    const combo = (p: NodeJS.Platform) => defaultBindings(p).filter((b) => b.action === 'mentionAgent').map((b) => b.combo);
    expect(combo('darwin')).toEqual(['Meta+Shift+2']);
    expect(combo('win32')).toEqual(['F2']);
    expect(combo('linux')).toEqual(['F2']);
  });

  it('matches ⌘⇧2 by the character (US/Korean `@`) and by the physical key (layouts where Shift+2 is `"`)', () => {
    const mac = defaultBindings('darwin');
    const ev = (key: string) => ({ key, code: 'Digit2', metaKey: true, shiftKey: true, ctrlKey: false, altKey: false });
    expect(resolveShortcut(ev('@'), mac)).toBe('mentionAgent');
    expect(resolveShortcut(ev('"'), mac)).toBe('mentionAgent');
    // ⌘2 alone stays the workspace jump.
    expect(resolveShortcut({ ...ev('2'), shiftKey: false }, mac)).toBe('workspace2');
  });

  it('can be moved or switched off in Settings like any built-in', () => {
    expect(effectiveBindings('win32', { mentionAgent: 'Ctrl+Shift+2' }).filter((b) => b.action === 'mentionAgent'))
      .toEqual([{ action: 'mentionAgent', combo: 'Ctrl+Shift+2' }]);
    expect(effectiveBindings('win32', { mentionAgent: null }).some((b) => b.action === 'mentionAgent')).toBe(false);
  });
});

describe('F2 capture gating (win32)', () => {
  it('opens the picker and swallows F2 in an agent pane', () => {
    seed(true);
    mount('win32');
    const { event } = press({ key: 'F2', code: 'F2' });
    expect(opened).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves F2 to the terminal in a plain shell pane', () => {
    seed(false);
    mount('win32');
    const { event, reachedTarget } = press({ key: 'F2', code: 'F2' });
    expect(opened).toBe(0);
    expect(event.defaultPrevented).toBe(false);
    expect(reachedTarget).toBe(true);
  });

  it('F2 typed into a floating pane shell stays there while a leaf agent is active', () => {
    seed(true);
    mount('win32');
    const floating = document.createElement('div');
    floating.setAttribute('data-terminal-pty', 'pty-floating');
    const textarea = document.createElement('textarea');
    floating.appendChild(textarea);
    document.body.appendChild(floating);
    const { event, reachedTarget } = press({ key: 'F2', code: 'F2' }, textarea);
    floating.remove();
    expect(opened).toBe(0);
    expect(event.defaultPrevented).toBe(false);
    expect(reachedTarget).toBe(true);
  });

  it('F2 from the agent pane\'s own terminal opens the picker', () => {
    seed(true);
    mount('win32');
    const own = document.createElement('div');
    own.setAttribute('data-terminal-pty', 'pty-1');
    const textarea = document.createElement('textarea');
    own.appendChild(textarea);
    document.body.appendChild(own);
    press({ key: 'F2', code: 'F2' }, textarea);
    own.remove();
    expect(opened).toBe(1);
  });

  it('switched off in Settings, F2 reaches even an agent pane', () => {
    seed(true, { mentionAgent: null });
    mount('win32');
    const { event } = press({ key: 'F2', code: 'F2' });
    expect(opened).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });
});

const noSourceToasts = (): number => useStore.getState().toasts
  .filter((toast) => toast.message === 'Focus an agent pane to mention another agent').length;

describe('⌘⇧2 on macOS', () => {
  it('opens the picker in an agent pane', () => {
    seed(true);
    mount('darwin');
    const { event } = press({ key: '@', code: 'Digit2', metaKey: true, shiftKey: true });
    expect(opened).toBe(1);
    expect(event.defaultPrevented).toBe(true);
    expect(noSourceToasts()).toBe(0);
  });

  it('in a plain shell pane, consumes the key and says why instead of doing nothing', () => {
    seed(false);
    mount('darwin');
    const own = document.createElement('div');
    own.setAttribute('data-terminal-pty', 'pty-1');
    const textarea = document.createElement('textarea');
    own.appendChild(textarea);
    document.body.appendChild(own);
    const { event } = press({ key: '@', code: 'Digit2', metaKey: true, shiftKey: true }, textarea);
    own.remove();
    expect(opened).toBe(0);
    expect(event.defaultPrevented).toBe(true);
    expect(noSourceToasts()).toBe(1);
  });

  it('with the sidebar focused and a shell active, shows the same toast', () => {
    seed(false);
    mount('darwin');
    const sidebarButton = document.createElement('button');
    document.body.appendChild(sidebarButton);
    const { event } = press({ key: '@', code: 'Digit2', metaKey: true, shiftKey: true }, sidebarButton);
    sidebarButton.remove();
    expect(opened).toBe(0);
    expect(event.defaultPrevented).toBe(true);
    expect(noSourceToasts()).toBe(1);
  });

  it('held down, it shows the toast once, not once per auto-repeat', () => {
    seed(false);
    mount('darwin');
    const sidebarButton = document.createElement('button');
    document.body.appendChild(sidebarButton);
    press({ key: '@', code: 'Digit2', metaKey: true, shiftKey: true }, sidebarButton);
    const held = press({ key: '@', code: 'Digit2', metaKey: true, shiftKey: true, repeat: true }, sidebarButton);
    press({ key: '@', code: 'Digit2', metaKey: true, shiftKey: true, repeat: true }, sidebarButton);
    sidebarButton.remove();
    expect(held.event.defaultPrevented).toBe(true);
    expect(noSourceToasts()).toBe(1);
  });

  it('from a pane other than the agent leaf (a floating pane), consumes the key with the toast', () => {
    seed(true);
    mount('darwin');
    const floating = document.createElement('div');
    floating.setAttribute('data-terminal-pty', 'pty-floating');
    const textarea = document.createElement('textarea');
    floating.appendChild(textarea);
    document.body.appendChild(floating);
    const { event } = press({ key: '@', code: 'Digit2', metaKey: true, shiftKey: true }, textarea);
    floating.remove();
    expect(opened).toBe(0);
    expect(event.defaultPrevented).toBe(true);
    expect(noSourceToasts()).toBe(1);
  });

  it('rebound to a key without ⌘ (F2), leaves it to the shell like Windows / Linux', () => {
    seed(false, { mentionAgent: 'F2' });
    mount('darwin');
    const { event, reachedTarget } = press({ key: 'F2', code: 'F2' });
    expect(opened).toBe(0);
    expect(event.defaultPrevented).toBe(false);
    expect(reachedTarget).toBe(true);
    expect(noSourceToasts()).toBe(0);
  });

  it('rebound to Ctrl+Shift+2 (a literal-Ctrl chord a TUI can read), leaves it to the shell', () => {
    seed(false, { mentionAgent: 'Ctrl+Shift+2' });
    mount('darwin');
    const { event } = press({ key: '@', code: 'Digit2', ctrlKey: true, shiftKey: true });
    expect(opened).toBe(0);
    expect(event.defaultPrevented).toBe(false);
    expect(noSourceToasts()).toBe(0);
  });
});

describe('no mention source on Windows / Linux', () => {
  it.each(['win32', 'linux'] as const)('%s: F2 in a shell is neither consumed nor toasted', (platform) => {
    seed(false);
    mount(platform);
    const { event, reachedTarget } = press({ key: 'F2', code: 'F2' });
    expect(opened).toBe(0);
    expect(event.defaultPrevented).toBe(false);
    expect(reachedTarget).toBe(true);
    expect(noSourceToasts()).toBe(0);
  });
});
