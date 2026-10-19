import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defaultBindings, resolveShortcut } from '../../../shared/keymap';

/**
 * Source-level regression lock (owner-reported 2026-07-19):
 *
 * On macOS, app shortcuts use ⌘ (the keymap's non-literalCtrl rows), so if the
 * xterm handler swallows Ctrl+D/K/I/N/T/,/` and bubbles them to the DOM, neither
 * the app action fires nor does the key reach the PTY, killing readline control
 * characters (Ctrl+D EOF, Ctrl+I Tab, Ctrl+K kill-line …) entirely. On mac, only
 * the literal-Ctrl bindings (prefix, bookmark, Ctrl+Shift+Arrow, …) may bubble.
 *
 * #1455: the handler no longer keeps its own per-OS bubble lists — it bubbles
 * exactly the keys the shared resolver maps to an action — so the per-OS
 * behaviour is pinned on the resolver's defaults here.
 *
 * Also, since copy is Cmd+C's job on mac, Ctrl+C must always be SIGINT even with an
 * active selection (copy interception is non-mac only).
 *
 * Like the imeCopyPaste lock, jsdom can't faithfully run xterm's custom key handler +
 * IME, so we pin it at the source level.
 */

const SRC = readFileSync(
  path.resolve(process.cwd(), 'src/renderer/hooks/useTerminal.ts'),
  'utf8',
);

const handlerStart = SRC.indexOf('attachCustomKeyEventHandler');
const HANDLER = SRC.slice(handlerStart);

describe('useTerminal macOS Ctrl passthrough (source-level lock)', () => {
  it('locates the custom key event handler', () => {
    expect(handlerStart).toBeGreaterThan(-1);
  });

  const ctrl = (key: string, code: string) => ({
    key, code, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
  });
  const READLINE_KEYS: [string, string][] = [
    ['d', 'KeyD'], ['k', 'KeyK'], ['i', 'KeyI'], ['n', 'KeyN'], ['t', 'KeyT'],
    [',', 'Comma'], ['`', 'Backquote'], ['=', 'Equal'], ['-', 'Minus'], ['0', 'Digit0'],
  ];

  it('on macOS literal Ctrl+D/K/I/N/T/,/`/=/-/0 are no shortcut — they reach the PTY', () => {
    for (const [key, code] of READLINE_KEYS) {
      expect(resolveShortcut(ctrl(key, code), defaultBindings('darwin')), `Ctrl+${key} on mac`).toBeNull();
    }
  });

  it('off macOS the same keys stay shortcuts (no win/linux regression)', () => {
    for (const [key, code] of READLINE_KEYS) {
      expect(resolveShortcut(ctrl(key, code), defaultBindings('win32')), `Ctrl+${key} on win32`).not.toBeNull();
    }
  });

  it('the literal-Ctrl bindings still bubble on macOS', () => {
    expect(resolveShortcut(ctrl('m', 'KeyM'), defaultBindings('darwin'))).toBe('addBookmark');
    expect(resolveShortcut({ ...ctrl('ArrowUp', 'ArrowUp'), shiftKey: true }, defaultBindings('darwin')))
      .toBe('focusUp');
  });

  it('bubbles only what the resolver maps — no hand-kept key lists', () => {
    expect(HANDLER).not.toMatch(/bubbleKeys|bubbleCodes/);
    expect(HANDLER).toContain('const shortcut = resolveShortcut(e, bindings);');
    expect(HANDLER).toContain('isPrefixTrigger(e, useStore.getState().prefixConfig.key)');
  });

  it('Ctrl+C copy interception is non-mac only — mac is always SIGINT', () => {
    // #1227: copy is still Windows/Linux-only (`!isMac`). The letter match
    // moved to resolveCtrlLetterByte so Dvorak logical C is SIGINT, with
    // the physical-KeyC IME fallback inside that helper.
    expect(HANDLER).toMatch(/!isMac && resolveCtrlLetterByte\(e\) === '\\x03'/);
  });

  it('Ctrl+V paste interception is non-mac only — mac passes through to the PTY as quoted-insert', () => {
    expect(HANDLER).toMatch(/!isMac && resolveCtrlLetterByte\(e\) === '\\x16'/);
  });
});
