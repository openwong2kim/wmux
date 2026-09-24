import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * #1455 Windows dogfood — under a Hangul composition one Ctrl+<letter> press
 * is two keydowns (`Process`, then the plain key). The pane gate must never
 * turn the second one into PTY input once the press was acted on, and must
 * arm the guard itself when it is the one that acts (a switched-off
 * shortcut's control byte). The guard's semantics are unit-tested in
 * shared/__tests__/keymap.test.ts and driven end to end through useKeyboard
 * in useKeyboard.imeDoubleFire.dynamic.test.tsx; jsdom cannot run xterm's
 * custom key handler, so this pins where the handler consults it.
 */

const SRC = readFileSync(
  path.resolve(process.cwd(), 'src/renderer/hooks/useTerminal.ts'),
  'utf8',
);

const handlerStart = SRC.indexOf('attachCustomKeyEventHandler');
const handlerEnd = SRC.indexOf('// Right-click behavior', handlerStart);
const HANDLER = SRC.slice(handlerStart, handlerEnd);

describe('useTerminal IME double keydown (source-level lock)', () => {
  it('drops a duplicate before any path can write it to the PTY', () => {
    const guard = HANDLER.indexOf('shortcutPressGuard.isDuplicate(e)');
    expect(guard).toBeGreaterThan(-1);
    // Before the first direct write (newline keys) and before the resolver.
    expect(guard).toBeLessThan(HANDLER.indexOf('resolveNewlineKeyByte('));
    expect(guard).toBeLessThan(HANDLER.indexOf('resolveShortcut(e, bindings)'));
    expect(HANDLER.slice(guard)).toMatch(
      /^shortcutPressGuard\.isDuplicate\(e\)\) \{\s*e\.preventDefault\(\);\s*return false;/,
    );
  });

  it('arms the guard when it writes a released shortcut byte', () => {
    const encode = HANDLER.indexOf('const releasedCtrl = resolveCtrlLetterByte(e);');
    const note = HANDLER.indexOf('shortcutPressGuard.noteActed(e);', encode);
    const write = HANDLER.indexOf('window.electronAPI.pty.write(ptyId, releasedCtrl);', encode);
    expect(encode).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(encode);
    expect(note).toBeLessThan(write);
  });
});
