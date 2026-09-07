import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Source-level regression lock: terminal copy/paste keybindings must match the
 * physical `code` (KeyC / KeyV), not just `e.key`.
 *
 * Under a CJK IME (Hangul, etc.) xterm derives Ctrl+<letter> from the deprecated
 * `keyCode`, which becomes 229 ("Process"). The DOM `keydown` then carries
 * `e.key` as the composed jamo ('ㅊ' / 'ㅍ') or 'Process' — never 'c' / 'v'.
 * A handler that only checks `e.key === 'c'` silently misses, so Ctrl+C falls
 * through to xterm and becomes SIGINT instead of copying — the reported
 * "Ctrl+C copy broken in Hangul input mode" bug. Same class as the Ctrl+J
 * newline (#258) and IME Escape (#189) fixes, which already match by code.
 *
 * The custom key handler runs against a real xterm Terminal plus DOM keydown
 * events that jsdom can't faithfully drive (and can't synthesize an active IME
 * at all), so the invariant is pinned at the source level — matching the
 * rightClickPasteMouseMode / atlasClear / webglTeardown locks in this dir.
 */

const SRC = readFileSync(
  path.resolve(process.cwd(), 'src/renderer/hooks/useTerminal.ts'),
  'utf8',
);

const handlerStart = SRC.indexOf('attachCustomKeyEventHandler');
const HANDLER = SRC.slice(handlerStart);

describe('useTerminal copy/paste survives a CJK IME (source-level lock)', () => {
  it('locates the custom key event handler', () => {
    expect(handlerStart).toBeGreaterThan(-1);
  });

  it('Ctrl+C copy matches physical KeyC, not only e.key', () => {
    // Windows/Linux copy uses resolveCtrlLetterByte (logical letter, IME
    // fallback on KeyC). macOS copy is still Cmd+C with the KeyC fallback.
    expect(HANDLER).toMatch(/!isMac && resolveCtrlLetterByte\(e\) === '\\x03'/);
    expect(HANDLER).toMatch(/e\.key === 'c' \|\| e\.code === 'KeyC'/);
  });

  it('Ctrl+V paste matches physical KeyV, not only e.key', () => {
    expect(HANDLER).toMatch(/!isMac && resolveCtrlLetterByte\(e\) === '\\x16'/);
    expect(HANDLER).toMatch(/e\.key === 'v' \|\| e\.code === 'KeyV'/);
  });

  it('Ctrl+Shift+C copy matches physical KeyC', () => {
    expect(HANDLER).toMatch(/e\.key === 'C' \|\| e\.code === 'KeyC'/);
  });

  it('Ctrl+Shift+V paste matches physical KeyV', () => {
    expect(HANDLER).toMatch(/e\.key === 'V' \|\| e\.code === 'KeyV'/);
  });

  it('the Ctrl+Shift catch-all exempts KeyC/KeyV so the copy/paste handlers below stay reachable', () => {
    // Without this exemption the Ctrl+Shift+C / Ctrl+Shift+V handlers are dead
    // (the catch-all returns false first).
    expect(HANDLER).toMatch(
      /e\.ctrlKey && e\.shiftKey && e\.code !== 'KeyC' && e\.code !== 'KeyV'/,
    );
  });
});
