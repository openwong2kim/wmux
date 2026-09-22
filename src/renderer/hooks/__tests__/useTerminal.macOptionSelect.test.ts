// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  installAltClickTrackingGuard,
  syncAltClickToMouseTracking,
} from '../../utils/altClickUnderMouseTracking';

// #1437 — macOS selection override under mouse tracking.
//
// When the foreground app turns on mouse tracking, xterm hands a plain drag to
// the app. The only way to still select is xterm's force-selection modifier:
// Shift off macOS, Option on macOS — and the macOS half exists only when
// `macOptionClickForcesSelection` is set. Forcing the selection also routes a
// short Option+click into xterm's click-to-move-cursor, which types arrow keys
// into the app, so that feature is tied to the tracking mode.
//
// Terminal construction is not reachable from a unit test; like the
// paneAdoption / daemonReattach tests, those invariants are read from source.

const RENDERER = path.join(__dirname, '..', '..');
const SITES = ['hooks/useTerminal.ts', 'components/Remote/RemoteMirrorTerminal.tsx'];

describe('#1437 — every interactive terminal opts in', () => {
  for (const rel of SITES) {
    it(`${rel}: sets the flag and installs the alt-click guard`, () => {
      const src = fs.readFileSync(path.join(RENDERER, rel), 'utf-8');
      const ctorAt = src.indexOf('new Terminal({');
      expect(ctorAt).toBeGreaterThan(-1);
      const ctorEnd = src.indexOf('\n    });', ctorAt);
      expect(ctorEnd).toBeGreaterThan(ctorAt);
      expect(src.slice(ctorAt, ctorEnd)).toMatch(/\bmacOptionClickForcesSelection: true,/);
      expect(src).toMatch(/const detachAltClickGuard = installAltClickTrackingGuard\(container, \w+\);/);
      expect(src).toMatch(/\n\s+detachAltClickGuard\(\);/);
    });
  }
});

describe('#1437 — the installed xterm still behaves as this relies on', () => {
  // Both bundles: tests load the CJS `main`, the renderer bundles the ESM
  // `module`. If an upgrade changes either override, fail here rather than in
  // a Mac user's pane.
  const pkgDir = path.dirname(require.resolve('@xterm/xterm/package.json'));
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'));
  for (const entry of [pkg.main, pkg.module] as string[]) {
    it(`${entry}: Option forces selection only with the flag; alt-click-move is option-gated`, () => {
      const bundle = fs.readFileSync(path.join(pkgDir, entry), 'utf-8');
      expect(bundle).toMatch(
        /shouldForceSelection\(\w+\)\{return [\w.]+\?\w+\.altKey&&this\._optionsService\.rawOptions\.macOptionClickForcesSelection:\w+\.shiftKey\}/,
      );
      expect(bundle).toMatch(/_handleMouseUp\(\w+\)\{[^}]*\w+\.altKey&&this\._optionsService\.rawOptions\.altClickMovesCursor\)/);
    });
  }
});

describe('installAltClickTrackingGuard', () => {
  const fakeTerm = (mode: string) => ({ modes: { mouseTrackingMode: mode }, options: { altClickMovesCursor: true } });

  it('turns click-to-move off while the app tracks the mouse, back on when it stops', () => {
    const term = fakeTerm('vt200');
    syncAltClickToMouseTracking(term);
    expect(term.options.altClickMovesCursor).toBe(false);
    term.modes.mouseTrackingMode = 'none';
    syncAltClickToMouseTracking(term);
    expect(term.options.altClickMovesCursor).toBe(true);
  });

  it('syncs on a capture-phase mousedown, before a child handler sees it', () => {
    const container = document.createElement('div');
    const child = document.createElement('div');
    container.appendChild(child);
    const term = fakeTerm('any');
    let seenByChild: boolean | undefined;
    child.addEventListener('mousedown', () => { seenByChild = term.options.altClickMovesCursor; });
    const detach = installAltClickTrackingGuard(container, term);
    child.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(seenByChild).toBe(false);

    detach();
    term.modes.mouseTrackingMode = 'none';
    child.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(term.options.altClickMovesCursor).toBe(false); // detached: no longer synced
  });
});
