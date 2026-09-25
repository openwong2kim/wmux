import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The mention picker key (F2 on Windows / Linux) leaves xterm only while an
 * agent pane or Chat view has focus. In a plain shell xterm must encode it
 * (ESC O Q) so mc / htop / vim keep F2 — the pane side of the gate that
 * useKeyboard.mentionAgent.dynamic.test pins for the window side. jsdom cannot
 * run xterm's custom key handler, so the wiring is pinned at the source like
 * useTerminal.composeBubble.test.
 */
const SRC = readFileSync(path.resolve(process.cwd(), 'src/renderer/hooks/useTerminal.ts'), 'utf8');
const start = SRC.indexOf('attachCustomKeyEventHandler');
const HANDLER = SRC.slice(start, SRC.indexOf('// Right-click behavior', start));

describe('mentionAgent pane gate', () => {
  it('bubbles only when the focused pane is a mention source', () => {
    expect(HANDLER).toMatch(
      /\} else if \(shortcut === 'mentionAgent'\) \{[\s\S]{0,300}?if \(mentionSourceForKey\(useStore\.getState\(\), e\.target\)\) return false;\r?\n {6}\} else if \(shortcut !== null\) \{/,
    );
  });

  it('is checked before the generic bubble, so a shell pane falls through to xterm', () => {
    expect(HANDLER.indexOf("shortcut === 'mentionAgent'"))
      .toBeLessThan(HANDLER.indexOf('return false; // let DOM bubble to useKeyboard'));
  });
});
