// @vitest-environment jsdom
//
// A command's shortcut can be set without leaving the palette: Ctrl+Enter on
// the active row records the next chord under the same rules Settings →
// Shortcuts applies (a refused chord explains itself and keeps recording),
// Backspace takes the key off, Esc cancels the recording but not the palette.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import { t } from '../../../i18n';
import CommandPalette from '../CommandPalette';
import { buildDefaultCustomKeybindings } from '../../../../shared/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {
    /* jsdom has no layout to scroll */
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    plugins: { list: async () => ({ plugins: [], failures: [] }) },
  };
  useStore.setState({ shortcutOverrides: {}, keyCaptureActive: false });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => useStore.getState().setCommandPaletteVisible(true));
  act(() => root.render(createElement(CommandPalette)));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => useStore.getState().setCommandPaletteVisible(false));
  useStore.setState({ shortcutOverrides: {}, keyCaptureActive: false });
});

const rows = () => Array.from(container.querySelectorAll<HTMLElement>('.overflow-y-auto > div'));
const rowFor = (label: string) => {
  const row = rows().find((r) => r.textContent?.includes(label));
  if (!row) throw new Error(`no palette row "${label}"`);
  return row;
};
const recordingPrompt = () => container.querySelector('[data-testid="palette-recording"]');

function selectRow(label: string) {
  act(() => {
    rowFor(label).dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  });
}

function startRecording() {
  const input = container.querySelector('input') as HTMLInputElement;
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  });
}

function press(init: KeyboardEventInit) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

describe('CommandPalette shortcut recording', () => {
  it('binds a key to a command that ships without one', () => {
    const label = t('palette.cmd.movePane.right');
    selectRow(label);
    startRecording();
    expect(recordingPrompt()).not.toBeNull();
    // useKeyboard stands down while the recorder owns the keyboard.
    expect(useStore.getState().keyCaptureActive).toBe(true);

    press({ key: 'p', code: 'KeyP', ctrlKey: true, altKey: true });

    expect(useStore.getState().shortcutOverrides.movePaneRight).toBe('Ctrl+Alt+P');
    expect(recordingPrompt()).toBeNull();
    expect(useStore.getState().keyCaptureActive).toBe(false);
    expect(useStore.getState().commandPaletteVisible).toBe(true);
    // The row now shows its key.
    expect(rowFor(label).querySelector('[data-testid="palette-shortcut-chip"]')?.textContent).toBe('Ctrl+Alt+P');
  });

  it('refuses a key another shortcut owns, says why, and keeps recording', () => {
    selectRow(t('palette.cmd.movePane.right'));
    startRecording();

    press({ key: 'd', code: 'KeyD', ctrlKey: true }); // Split pane horizontal

    expect(useStore.getState().shortcutOverrides.movePaneRight).toBeUndefined();
    expect(recordingPrompt()).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toBe(t('settings.sc.conflict', { name: t('settings.sc.splitHorizontal') }));

    press({ key: 'p', code: 'KeyP', ctrlKey: true, altKey: true });
    expect(useStore.getState().shortcutOverrides.movePaneRight).toBe('Ctrl+Alt+P');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('moves a built-in that already has a key', () => {
    selectRow(t('palette.cmd.splitRight'));
    startRecording();
    press({ key: 'h', code: 'KeyH', ctrlKey: true, altKey: true });
    expect(useStore.getState().shortcutOverrides.splitHorizontal).toBe('Ctrl+Alt+H');
  });

  it('Backspace takes the key off', () => {
    useStore.setState({ shortcutOverrides: { movePaneRight: 'Ctrl+Alt+P' } });
    selectRow(t('palette.cmd.movePane.right'));
    startRecording();
    press({ key: 'Backspace', code: 'Backspace' });
    // Unbound by default: the override goes, which leaves no key.
    expect('movePaneRight' in useStore.getState().shortcutOverrides).toBe(false);

    selectRow(t('palette.cmd.splitRight'));
    startRecording();
    press({ key: 'Backspace', code: 'Backspace' });
    // A built-in with a default key is switched off instead.
    expect(useStore.getState().shortcutOverrides.splitHorizontal).toBeNull();
  });

  it('holds focus on the prompt while recording, so an IME has nowhere to type', () => {
    // The search input unmounts when recording starts. Without this, focus fell
    // back to the terminal and Hangul composed there reached the shell.
    selectRow(t('palette.cmd.movePane.right'));
    startRecording();
    expect(document.activeElement).toBe(recordingPrompt());
    press({ key: 'a', code: 'KeyA' }); // refused: needs a modifier
    expect(document.activeElement).toBe(recordingPrompt());
  });

  it('Esc cancels the recording, not the palette', () => {
    selectRow(t('palette.cmd.movePane.right'));
    startRecording();
    press({ key: 'Escape', code: 'Escape' });
    expect(recordingPrompt()).toBeNull();
    expect(useStore.getState().commandPaletteVisible).toBe(true);
    expect(useStore.getState().shortcutOverrides).toEqual({});
  });

  it('does nothing on a row that has no shortcut action', () => {
    // A workspace row: there is no keymap action behind it.
    const wsName = useStore.getState().workspaces[0]?.name;
    if (!wsName) return;
    selectRow(wsName);
    startRecording();
    expect(recordingPrompt()).toBeNull();
  });
});

// #1885 — the palette used to take a custom keybinding's key with no word.
describe('CommandPalette shortcut recording onto a custom keybinding key', () => {
  const dialog = () => container.querySelector<HTMLElement>('[data-testid="key-conflict-confirm"]');
  const button = (attr: string) => container.querySelector<HTMLButtonElement>(`[${attr}]`) as HTMLButtonElement;
  const click = (el: HTMLElement) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

  beforeEach(() => {
    useStore.setState({ customKeybindings: buildDefaultCustomKeybindings('win32').map((kb) => ({ ...kb })) });
  });

  it('asks before F7 stops running the custom keybinding; Cancel keeps it', () => {
    selectRow(t('palette.cmd.movePane.right'));
    startRecording();
    press({ key: 'F7', code: 'F7' });

    expect(recordingPrompt()).toBeNull();
    expect(useStore.getState().keyCaptureActive).toBe(false);
    expect(dialog()?.textContent).toContain('F7 is already used by “Claude (skip permissions)”');
    expect(useStore.getState().shortcutOverrides).toEqual({});

    click(button('data-key-conflict-cancel'));
    expect(dialog()).toBeNull();
    expect(useStore.getState().shortcutOverrides).toEqual({});
    expect(useStore.getState().commandPaletteVisible).toBe(true);
  });

  it('Use anyway gives the command F7', () => {
    selectRow(t('palette.cmd.movePane.right'));
    startRecording();
    press({ key: 'F7', code: 'F7' });
    click(button('data-key-conflict-confirm'));
    expect(dialog()).toBeNull();
    expect(useStore.getState().shortcutOverrides.movePaneRight).toBe('F7');
  });

  it('no question for a key no custom keybinding uses', () => {
    selectRow(t('palette.cmd.movePane.right'));
    startRecording();
    press({ key: 'F8', code: 'F8' });
    expect(dialog()).toBeNull();
    expect(useStore.getState().shortcutOverrides.movePaneRight).toBe('F8');
  });
});
