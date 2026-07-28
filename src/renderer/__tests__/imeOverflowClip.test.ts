// Source-level regression lock for the IME composition overflow guard (#678).
//
// The bug: xterm anchors its hidden IME helper textarea at the app's buffer
// cursor. A TUI that ends its redraw with the cursor parked at the right edge
// (Kimi Code's right-aligned input-row hint) pushes the preedit-holding
// textarea past the screen's right bound, and Chromium's scroll-into-view on
// the IME caret then drags every overflow:hidden ancestor sideways — the
// whole pane tears horizontally during composition and snaps back on commit.
//
// The fix is a CSS invariant: `.xterm` and `.xterm-screen` use
// `overflow: clip`, which paints like overflow:hidden but creates no scroll
// container, so a misplaced textarea is clipped instead of dragging the pane.
// Reverting this to hidden/visible (or deleting the rule) silently brings the
// tearing back, and no jsdom test can see it — lock the source instead.

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'globals.css'), 'utf8');

/** Every declaration block whose selector list targets .xterm or .xterm-screen. */
function xtermRuleBlocks(): string[] {
  const blocks: string[] = [];
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const selector = m[1];
    if (/(^|,)\s*\.xterm\s*$/.test(selector) || /(^|,)\s*\.xterm\s+\.xterm-screen\s*$/.test(selector)) {
      blocks.push(m[2]);
    }
  }
  return blocks;
}

describe('IME composition overflow guard (#678)', () => {
  it('every .xterm/.xterm-screen rule individually declares overflow: clip', () => {
    const blocks = xtermRuleBlocks();
    expect(blocks.length, 'globals.css has no overflow rule for .xterm/.xterm-screen').toBeGreaterThan(0);
    // Per-rule, not aggregate: one clipped rule must not cover for a sibling
    // that forgot it.
    for (const block of blocks) {
      expect(block).toContain('overflow: clip');
    }
  });

  it('no .xterm/.xterm-screen rule uses a scroll-container overflow', () => {
    for (const block of xtermRuleBlocks()) {
      expect(block).not.toMatch(/overflow(-x|-y)?:\s*(hidden|visible|scroll|auto)\b/);
    }
  });

  it('the scrollbar rules are untouched (vertical scrolling must survive)', () => {
    // The guard must never clip .xterm-viewport / the Monaco scrollable element —
    // terminal scrollback depends on their overflow-y.
    expect(css).not.toMatch(/\.xterm-viewport\s*\{[^}]*overflow:\s*clip/);
    expect(css).not.toMatch(/xterm-scrollable-element[^{]*\{[^}]*overflow:\s*clip/);
  });
});
