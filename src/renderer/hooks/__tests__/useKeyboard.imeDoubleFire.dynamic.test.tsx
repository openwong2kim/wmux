// @vitest-environment jsdom
//
// #1455 Windows dogfood — while a Hangul IME composition is open, Chromium
// delivers TWO keydowns for one Ctrl+T: `key='Process', code='KeyT'`, then,
// once the IME commits, `key='t', code='KeyT'`. Both resolve to the same
// shortcut, so Ctrl+T opened two tabs and one Ctrl+W closed two. One physical
// press must run its shortcut once — whether both keydowns arrive, only the
// Process one does, or only the plain one does. Drives the real hook and
// store with real KeyboardEvent sequences.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createLeafPane, createSurface, createWorkspace } from '../../../shared/types';
import { getLeafPanes } from '../../../shared/paneUtils';
import { useStore } from '../../stores';
import { useKeyboard } from '../useKeyboard';

const createTerminalSurface = vi.hoisted(() => vi.fn());
vi.mock('../../utils/createTerminalSurface', () => ({ createTerminalSurface }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  function Harness(): null {
    useKeyboard();
    return null;
  }
  act(() => {
    root.render(React.createElement(Harness));
  });
}

interface Chord { code: string; key: string; shift?: boolean }

/** Dispatch one keydown; report whether a later (bubble) listener saw it. */
function keydown(init: KeyboardEventInit): { event: KeyboardEvent; reachedTarget: boolean } {
  let reachedTarget = false;
  const later = (): void => { reachedTarget = true; };
  window.addEventListener('keydown', later);
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    window.dispatchEvent(event);
  });
  window.removeEventListener('keydown', later);
  return { event, reachedTarget };
}

function keyup(code: string, key: string): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, code, key, ctrlKey: true }));
  });
}

const mods = (c: Chord) => ({ ctrlKey: true, shiftKey: c.shift ?? false });

/** One physical press under a Hangul composition: Process, then the real key. */
function pressWithIme(c: Chord, opts: { isComposing?: boolean; followUp?: boolean } = {}) {
  const first = keydown({ ...mods(c), code: c.code, key: 'Process', keyCode: 229, isComposing: opts.isComposing ?? true });
  const second = opts.followUp === false ? null : keydown({ ...mods(c), code: c.code, key: c.key });
  keyup(c.code, c.key);
  return { first, second };
}

function pressPlain(c: Chord) {
  const r = keydown({ ...mods(c), code: c.code, key: c.key });
  keyup(c.code, c.key);
  return r;
}

const CTRL_T: Chord = { code: 'KeyT', key: 't' };
const CTRL_W: Chord = { code: 'KeyW', key: 'w' };
const CTRL_D: Chord = { code: 'KeyD', key: 'd' };
const CTRL_SHIFT_W: Chord = { code: 'KeyW', key: 'W', shift: true };

function seed(): void {
  const workspaces = ['one', 'two', 'three', 'four'].map((name) => {
    const ws = createWorkspace(name);
    const leaf = createLeafPane();
    leaf.surfaces = ['a', 'b', 'c', 'd'].map((p) => createSurface(`${name}-${p}`, 'pwsh', 'C:\\'));
    leaf.activeSurfaceId = leaf.surfaces[0].id;
    ws.rootPane = leaf;
    ws.activePaneId = leaf.id;
    return ws;
  });
  act(() => {
    useStore.setState((state) => {
      state.workspaces = workspaces;
      state.activeWorkspaceId = workspaces[0].id;
      state.shortcutOverrides = {};
      state.paneGate = 'ready';
      state.setPrefixMode(false);
    });
  });
}

const activeWs = () => {
  const s = useStore.getState();
  return s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? s.workspaces[0];
};
const tabCount = () => getLeafPanes(activeWs().rootPane)[0].surfaces.length;
const paneCount = () => getLeafPanes(activeWs().rootPane).length;
const workspaceCount = () => useStore.getState().workspaces.length;

// Each case: how to read the action's effect, and the effect of ONE run.
const CASES: Array<{ name: string; chord: Chord; read: () => number; once: number }> = [
  { name: 'Ctrl+T (new tab)', chord: CTRL_T, read: () => createTerminalSurface.mock.calls.length, once: 1 },
  { name: 'Ctrl+W (close tab)', chord: CTRL_W, read: tabCount, once: 3 },
  { name: 'Ctrl+D (split)', chord: CTRL_D, read: paneCount, once: 2 },
  { name: 'Ctrl+Shift+W (close workspace)', chord: CTRL_SHIFT_W, read: workspaceCount, once: 3 },
];

beforeEach(() => {
  createTerminalSurface.mockReset();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'win32',
    window: { hide: vi.fn() },
    pty: { dispose: vi.fn(), create: vi.fn(), write: vi.fn() },
  };
  seed();
  mount();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Windows IME: one physical press runs a shortcut once', () => {
  for (const { name, chord, read, once } of CASES) {
    describe(name, () => {
      it('Process keydown + plain follow-up → fires once, follow-up swallowed', () => {
        const { first, second } = pressWithIme(chord);
        expect(read()).toBe(once);
        expect(first.event.defaultPrevented).toBe(true);
        // The follow-up must not reach xterm either, or it becomes a PTY byte.
        expect(second?.event.defaultPrevented).toBe(true);
        expect(second?.reachedTarget).toBe(false);
      });

      it('Process keydown with isComposing=false + follow-up → fires once', () => {
        pressWithIme(chord, { isComposing: false });
        expect(read()).toBe(once);
      });

      it('Process keydown only (no follow-up) → fires once', () => {
        pressWithIme(chord, { followUp: false });
        expect(read()).toBe(once);
      });

      it('plain keydown only (no IME) → fires once', () => {
        pressPlain(chord);
        expect(read()).toBe(once);
      });
    });
  }

  it('two separate IME presses fire twice', () => {
    pressWithIme(CTRL_T);
    pressWithIme(CTRL_T);
    expect(createTerminalSurface).toHaveBeenCalledTimes(2);
  });

  it('a Process-only press, then a plain press of the same key, fire twice', () => {
    pressWithIme(CTRL_T, { followUp: false });
    pressPlain(CTRL_T);
    expect(createTerminalSurface).toHaveBeenCalledTimes(2);
  });

  it('two quick plain presses fire twice', () => {
    pressPlain(CTRL_T);
    pressPlain(CTRL_T);
    expect(createTerminalSurface).toHaveBeenCalledTimes(2);
  });

  it('a held key repeats once per repeat, whether repeats come as pairs or plain', () => {
    const imeKey = { ctrlKey: true, code: 'KeyT', key: 'Process', keyCode: 229 };
    const plain = { ctrlKey: true, code: 'KeyT', key: 't' };
    // Every repeat as a Process + plain pair.
    keydown(imeKey);
    keydown(plain);
    keydown({ ...imeKey, repeat: true });
    keydown({ ...plain, repeat: true });
    keydown({ ...imeKey, repeat: true });
    keydown({ ...plain, repeat: true });
    keyup('KeyT', 't');
    expect(createTerminalSurface).toHaveBeenCalledTimes(3);
    // Composition committed by the first pair; repeats come plain.
    keydown(imeKey);
    keydown(plain);
    keydown({ ...plain, repeat: true });
    keydown({ ...plain, repeat: true });
    keyup('KeyT', 't');
    expect(createTerminalSurface).toHaveBeenCalledTimes(6);
    // No IME at all: a held key repeats as before.
    keydown(plain);
    keydown({ ...plain, repeat: true });
    keyup('KeyT', 't');
    expect(createTerminalSurface).toHaveBeenCalledTimes(8);
  });

  it('a follow-up with other modifiers is its own chord', () => {
    keydown({ ctrlKey: true, code: 'KeyT', key: 'Process', keyCode: 229, isComposing: true });
    // Ctrl+Shift+T is not the Ctrl+T press repeated.
    const other = keydown({ ctrlKey: true, shiftKey: true, code: 'KeyT', key: 'T' });
    expect(createTerminalSurface).toHaveBeenCalledTimes(1);
    expect(other.reachedTarget).toBe(true);
  });

  it('non-shortcut IME keys are untouched', () => {
    // Composing Hangul: bare Process keydowns followed by their jamo.
    const a = keydown({ code: 'KeyR', key: 'Process', keyCode: 229, isComposing: true });
    const b = keydown({ code: 'KeyR', key: 'r' });
    for (const r of [a, b]) {
      expect(r.event.defaultPrevented).toBe(false);
      expect(r.reachedTarget).toBe(true);
    }
    expect(createTerminalSurface).not.toHaveBeenCalled();
  });

  it('a switched-off shortcut is not armed by the app: both keydowns go on to the pane', () => {
    act(() => {
      useStore.setState((state) => { state.shortcutOverrides = { newSurface: null }; });
    });
    const { first, second } = pressWithIme(CTRL_T);
    expect(createTerminalSurface).not.toHaveBeenCalled();
    expect(first.reachedTarget).toBe(true);
    expect(second?.reachedTarget).toBe(true);
  });

  it('prefix trigger under IME: the follow-up does not act as a prefix-mode key', () => {
    pressWithIme({ code: 'KeyB', key: 'b' });
    expect(useStore.getState().prefixMode).toBe(true);
    expect(useStore.getState().prefixError).toBeNull();
    // A real prefix key after it still works (c → new workspace).
    keydown({ code: 'KeyC', key: 'c' });
    expect(workspaceCount()).toBe(5);
    expect(useStore.getState().prefixMode).toBe(false);
  });
});
