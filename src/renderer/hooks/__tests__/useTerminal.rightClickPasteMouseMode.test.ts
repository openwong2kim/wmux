import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Source-level regression lock: right-click paste must yield to the foreground
 * app's mouse mode.
 *
 * When a TUI enables mouse tracking (xterm mouseTrackingMode x10/vt200/drag/any,
 * i.e. DECSET 9/1000/1002/1003 — vim `:set mouse=a`, htop, tmux, lazygit), a
 * plain right-click is already delivered to it as a mouse event. wmux's
 * `contextmenu` handler must therefore NOT also paste, or the single click is
 * handled twice — the reported right-click double-paste. Shift+right-click
 * forces wmux's own paste, matching Windows Terminal's Shift-override.
 *
 * The contextmenu handler runs against a real xterm Terminal plus DOM events
 * that jsdom can't faithfully drive, so the invariant is pinned at the source
 * level (matching the atlasClear / webglTeardown regression locks in this dir).
 * Assertions are scoped to the contextmenu handler slice so unrelated paste
 * sites (the Ctrl+V / Ctrl+Shift+V handlers) can't satisfy them by accident.
 */

const SRC = readFileSync(
  path.resolve(process.cwd(), 'src/renderer/hooks/useTerminal.ts'),
  'utf8',
);

// Slice just the contextmenu handler: from its registration to the catch that
// logs '[wmux:clipboard] right-click error:'.
const handlerStart = SRC.indexOf("addEventListener('contextmenu'");
const handlerEnd = SRC.indexOf('right-click error:', handlerStart);
const HANDLER = SRC.slice(handlerStart, handlerEnd);

describe('useTerminal right-click paste yields to mouse mode (source-level lock)', () => {
  it('locates the contextmenu handler', () => {
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
  });

  it('reads the foreground app mouse mode in the contextmenu handler', () => {
    expect(HANDLER).toMatch(/modes\?\.mouseTrackingMode/);
  });

  it('bails out of the paste when mouse mode is on and Shift is not held', () => {
    expect(HANDLER).toMatch(
      /if\s*\(\s*mouseMode\s*!==\s*['"]none['"]\s*&&\s*!e\.shiftKey\s*\)\s*\{\s*return;/,
    );
  });

  it('keeps Shift+right-click a true override of the post-copy suppression window', () => {
    expect(HANDLER).toMatch(
      /if\s*\(\s*!e\.shiftKey\s*&&\s*Date\.now\(\)\s*-\s*lastRightClickCopyAt\s*<\s*RIGHT_CLICK_PASTE_SUPPRESS_MS\s*\)/,
    );
  });

  it('guards only the no-selection paste — after the selection-copy branch, before the paste write', () => {
    const idxCopyBranch = HANDLER.indexOf('lastRightClickCopyAt = Date.now()');
    const idxGuard = HANDLER.indexOf('mouseTrackingMode');
    const idxPaste = HANDLER.indexOf('pastePtyChunked(');

    expect(idxCopyBranch).toBeGreaterThan(-1);
    // Guard sits AFTER the selection→copy branch, so selecting + right-clicking
    // still copies (the guard never runs for that path).
    expect(idxGuard).toBeGreaterThan(idxCopyBranch);
    // Guard sits BEFORE the paste write, so it can suppress it.
    expect(idxPaste).toBeGreaterThan(idxGuard);
  });
});
