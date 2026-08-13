import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// #879 wiring lock (source-level).
//
// windowWakeRepaint.test.ts proves the coordinator's behaviour against injected
// deps. What it cannot prove is that anything is actually plugged into it: a
// coordinator with zero registered panes is a silent no-op, and that is exactly
// the failure mode of this bug (a repair path that exists but never fires).
// Mounting useTerminal for real needs a WebGL context and the whole preload
// bridge, so the wiring is pinned at the source level — the same approach
// useTerminal.atlasClear.test.ts takes for the #191 invariant.

const hookSrc = fs.readFileSync(path.join(__dirname, '..', 'useTerminal.ts'), 'utf-8');
const layoutSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'components', 'Layout', 'AppLayout.tsx'),
  'utf-8',
);

describe('#879 — every pane is registered with the window-wake coordinator', () => {
  const start = hookSrc.indexOf('windowWakeRepaint.register({');
  const registerBlock = hookSrc.slice(start, hookSrc.indexOf('});', start));

  it('useTerminal registers each terminal', () => {
    expect(start).toBeGreaterThan(-1);
  });

  it('reports pane visibility from isVisibleRef so hidden panes are skipped', () => {
    // A hidden pane already repaints through glyphRepaint's `visible` reason
    // when its workspace/tab comes back; waking it here would be a full-range
    // refresh nobody can see.
    expect(registerBlock).toMatch(/isVisible:\s*\(\)\s*=>\s*isVisibleRef\.current/);
  });

  it('routes the repaint through the pane glyphRepaint scheduler, not a second timer', () => {
    expect(registerBlock).toMatch(/glyphRepaint\.onWindowWake\(\)/);
  });

  it('unregisters on teardown, next to the other per-pane registrations', () => {
    const teardown = hookSrc.slice(hookSrc.indexOf('unregisterAtlasGuard();'));
    expect(teardown).toMatch(/unregisterWindowWake\(\);/);
  });
});

describe('#879 — the coordinator is Windows-gated at the single init site', () => {
  it('AppLayout initialises it once', () => {
    expect(layoutSrc).toMatch(/windowWakeRepaint\.init\(\{/);
  });

  it('enables it only on win32', () => {
    // macOS and Linux do flip document.visibilityState, so atlasWakeRecovery
    // already covers their wake boundaries. Enabling this there would be two
    // extra full-range refreshes per visible pane per app switch, with no
    // evidence behind them.
    const initBlock = layoutSrc.slice(
      layoutSrc.indexOf('windowWakeRepaint.init({'),
      layoutSrc.indexOf('}), []);', layoutSrc.indexOf('windowWakeRepaint.init({')),
    );
    expect(initBlock).toMatch(/enabled:\s*window\.electronAPI\?\.platform === 'win32'/);
  });
});
