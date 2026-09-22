import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// #1437 — macOS selection override under mouse tracking, locked at the source
// level (useTerminal's construction is not reachable from a unit test; same
// approach as the paneAdoption / daemonReattach tests).
//
// When the foreground app turns on mouse tracking, xterm hands a plain drag to
// the app. The only way to still select is xterm's force-selection modifier:
// Shift off macOS, Option on macOS — and the macOS half exists only when
// `macOptionClickForcesSelection` is set. Dropping the flag silently removes
// the one way a Mac user can copy out of a Claude Code pane.
describe('#1437 — macOS Option+drag forces selection', () => {
  it('constructs the terminal with macOptionClickForcesSelection on', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'useTerminal.ts'), 'utf-8');
    const ctorAt = src.indexOf('new Terminal({');
    expect(ctorAt).toBeGreaterThan(-1);
    const ctorEnd = src.indexOf('\n    });', ctorAt);
    expect(ctorEnd).toBeGreaterThan(ctorAt);
    expect(src.slice(ctorAt, ctorEnd)).toMatch(/\bmacOptionClickForcesSelection: true,/);
  });

  it('the installed xterm still gates macOS forced selection on that flag', () => {
    // If an xterm upgrade changes the override, the flag above may stop doing
    // anything — fail here instead of in a Mac user's pane.
    const xtermMain = require.resolve('@xterm/xterm');
    const bundle = fs.readFileSync(xtermMain, 'utf-8');
    expect(bundle).toMatch(
      /shouldForceSelection\(\w+\)\{return \w+\.isMac\?\w+\.altKey&&this\._optionsService\.rawOptions\.macOptionClickForcesSelection:\w+\.shiftKey\}/,
    );
  });
});
