// @vitest-environment jsdom
//
// PC rail chords (Shift+Alt+Up/Down/Home) are keymap rows, but the rail takes
// them only while a computer is paired and no custom keybinding sits on the
// chord. Otherwise they reach the pane: useKeyboard leaves the event alone and
// useTerminal's predicate (isPcRailAction + pcRailClaimsKey) hands it to xterm.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createWorkspace } from '../../../shared/types';
import { effectiveBindings, resolveShortcut } from '../../../shared/keymap';
import { LOCAL_PC_ID } from '../../../shared/pcRail';
import { useStore } from '../../stores';
import { useKeyboard } from '../useKeyboard';
import { isPcRailAction, pcRailClaimsKey } from '../../components/PcRail/pcRailModel';

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
  act(() => root.render(React.createElement(Harness)));
}

function press(key: string): { event: KeyboardEvent; reached: boolean } {
  let reached = false;
  const later = (): void => { reached = true; };
  window.addEventListener('keydown', later);
  const event = new KeyboardEvent('keydown', { key, code: key, shiftKey: true, altKey: true, bubbles: true, cancelable: true });
  act(() => { window.dispatchEvent(event); });
  window.removeEventListener('keydown', later);
  return { event, reached };
}

/** What useTerminal decides for the same keydown: true = xterm encodes it. */
function terminalGetsIt(key: string): boolean {
  const e = new KeyboardEvent('keydown', { key, code: key, shiftKey: true, altKey: true });
  const action = resolveShortcut(e, effectiveBindings('win32', useStore.getState().shortcutOverrides));
  return isPcRailAction(action) && !pcRailClaimsKey(useStore.getState(), e);
}

function seed(hosts: string[], customKeys: string[] = []): void {
  const ws = createWorkspace('one');
  act(() => {
    useStore.setState((state) => {
      state.workspaces = [ws];
      state.activeWorkspaceId = ws.id;
      state.shortcutOverrides = {};
      state.customKeybindings = customKeys.map((key) => ({ key, label: 'x', command: 'echo x' })) as typeof state.customKeybindings;
      state.pcRailHosts = hosts.map((id) => ({ id, label: id }));
      state.pcRailHostsLoaded = true;
      state.pcRail = { activePcId: LOCAL_PC_ID, lastWorkspaceByPc: {}, mutedPcs: [] };
      state.setPrefixMode(false);
    });
  });
}

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'win32',
    window: { hide: vi.fn() },
    pty: { dispose: vi.fn(), create: vi.fn(), write: vi.fn() },
  };
});
afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
});

describe('PC rail chords', () => {
  it('with no paired computer, Shift+Alt+Up/Down/Home reach the terminal', () => {
    seed([]);
    mount();
    for (const key of ['ArrowUp', 'ArrowDown', 'Home']) {
      const { event, reached } = press(key);
      expect(event.defaultPrevented, key).toBe(false);
      expect(reached, key).toBe(true);
      expect(terminalGetsIt(key), key).toBe(true);
    }
    expect(useStore.getState().pcRail.activePcId).toBe(LOCAL_PC_ID);
  });

  it('with a paired computer, the rail takes them', () => {
    seed(['h1', 'h2']);
    mount();
    expect(press('ArrowDown').event.defaultPrevented).toBe(true);
    expect(useStore.getState().pcRail.activePcId).toBe('h1');
    press('ArrowUp');
    expect(useStore.getState().pcRail.activePcId).toBe(LOCAL_PC_ID);
    press('ArrowUp');
    expect(useStore.getState().pcRail.activePcId).toBe('h2');
    press('Home');
    expect(useStore.getState().pcRail.activePcId).toBe(LOCAL_PC_ID);
    expect(terminalGetsIt('ArrowDown')).toBe(false);
  });

  it('leaves a chord to a custom keybinding on it', () => {
    seed(['h1'], ['Shift+Alt+ArrowDown']);
    mount();
    press('ArrowDown');
    expect(useStore.getState().pcRail.activePcId).toBe(LOCAL_PC_ID);
    expect(terminalGetsIt('ArrowDown')).toBe(true);
  });

  it('follows a rebinding in Settings', () => {
    seed(['h1']);
    act(() => useStore.setState((s) => { s.shortcutOverrides = { nextPc: 'Ctrl+Alt+P' }; }));
    mount();
    press('ArrowDown');
    expect(useStore.getState().pcRail.activePcId).toBe(LOCAL_PC_ID);
  });
});

describe('useTerminal hands an unclaimed PC chord to xterm', () => {
  it('checks the rail before any resolved built-in bubbles out of the pane', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const src = readFileSync(path.resolve(process.cwd(), 'src/renderer/hooks/useTerminal.ts'), 'utf8');
    const gate = src.indexOf('if (isPcRailAction(shortcut) && !pcRailClaimsKey(useStore.getState(), e)) return true;');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(src.indexOf('return false; // let DOM bubble to useKeyboard'));
  });
});
