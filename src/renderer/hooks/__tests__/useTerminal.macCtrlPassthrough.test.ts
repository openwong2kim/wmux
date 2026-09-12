import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Source-level regression lock (owner-reported 2026-07-19):
 *
 * On macOS, app shortcuts use cmdOrCtrl=metaKey (useKeyboard), so if the xterm
 * handler swallows Ctrl+D/K/I/N/T/,/` and bubbles them to the DOM, neither the app
 * action fires nor does the key reach the PTY, killing readline control characters
 * (Ctrl+D EOF, Ctrl+I Tab, Ctrl+K kill-line …) entirely. On mac, only the literal-Ctrl
 * bindings (b=prefix, m=bookmark, Ctrl+Arrow) should bubble; the rest must pass through
 * to the PTY.
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

  it('the mac bubble list contains only the literal-Ctrl bindings (b, m, Arrow)', () => {
    expect(HANDLER).toMatch(
      /isMac\s*\?\s*\['b', 'm', 'ArrowUp', 'ArrowDown'\]/,
    );
    expect(HANDLER).toMatch(
      /isMac\s*\?\s*\['KeyB', 'KeyM', 'ArrowUp', 'ArrowDown'\]/,
    );
  });

  it('the non-mac bubble list keeps the full original set (no win/linux regression)', () => {
    expect(HANDLER).toMatch(
      /\[',', 'b', 'd', 'k', 'i', 'n', 't', 'm', 'ArrowUp', 'ArrowDown', '`'\]/,
    );
  });

  it('Ctrl+` and Ctrl+=/-/0 zoom bubbling are non-mac only', () => {
    expect(HANDLER).toMatch(/!isMac && e\.ctrlKey && !e\.shiftKey && e\.code === 'Backquote'/);
    expect(HANDLER).toMatch(/!isMac && e\.ctrlKey && !e\.shiftKey && \(\s*\n?\s*e\.key === '='/);
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
