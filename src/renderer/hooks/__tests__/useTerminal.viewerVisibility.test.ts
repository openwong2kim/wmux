import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// #882 wiring lock (source-level).
//
// viewerVisibility.test.ts proves the decision; this proves the decision is
// actually the one useTerminal makes. A pure function nobody calls is exactly
// how this bug survived: #766 shipped a correct-looking expression whose window
// term was dead on Windows, and no test noticed because no test asserted what
// fed it. Mounting useTerminal for real needs a WebGL context and the whole
// preload bridge, so the wiring is pinned here, as useTerminal.atlasClear.test.ts
// does for the #191 invariant.

const hookSrc = fs.readFileSync(path.join(__dirname, '..', 'useTerminal.ts'), 'utf-8');
const layoutSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'components', 'Layout', 'AppLayout.tsx'),
  'utf-8',
);

describe('#882 — the viewer-visibility report is fed by the window-displayed bit', () => {
  it('useTerminal subscribes to the window-displayed store', () => {
    expect(hookSrc).toMatch(/const windowDisplayed = useWindowDisplayed\(\);/);
  });

  it('the report goes through the shared decision, not an inline expression', () => {
    const start = hookSrc.indexOf('const { viewerVisible, windowVisible, refit } = decideViewerVisibility({');
    expect(start).toBeGreaterThan(-1);
    const block = hookSrc.slice(start, hookSrc.indexOf('});', start));
    expect(block).toMatch(/paneVisible: isVisible/);
    expect(block).toMatch(/docVisible,/);
    expect(block).toMatch(/windowDisplayed,/);
    expect(block).toMatch(/prevWindowVisible: prevWindowVisibleRef\.current/);
  });

  it('the effect re-runs when the window-displayed bit flips', () => {
    // Without windowDisplayed in the dependency list the report would be
    // computed once and never revisited — the same silent staleness as the
    // original bug, one layer up.
    const start = hookSrc.indexOf('const { viewerVisible, windowVisible, refit } = decideViewerVisibility({');
    const deps = hookSrc.slice(start, hookSrc.indexOf('\n  }, [', start) + 200);
    expect(deps).toMatch(/\}, \[ptyId, isVisible, docVisible, windowDisplayed, fit\]\);/);
  });
});

describe('#882 — a daemon reattach cannot silently revert the report', () => {
  it('replays the last reported value after reconnect', () => {
    // The daemon starts sessions at viewerVisible:true and resets to true on
    // detach, and this pane's visibility will not change just because the
    // daemon respawned — so without a replay the desk would go back to owning
    // the size for a pane nobody can see.
    const start = hookSrc.indexOf('void reconnectPtyWithRetry(id,');
    expect(start).toBeGreaterThan(-1);
    const block = hookSrc.slice(start, hookSrc.indexOf('.finally(', start));
    expect(block).toMatch(/reportViewerVisibility\(id, viewerVisibleRef\.current\)/);
    expect(block).toMatch(/if \(ptyIdRef\.current !== id\) return;/);
  });
});

describe('#882 — the store is initialised once for the app', () => {
  it('AppLayout initialises it', () => {
    expect(layoutSrc).toMatch(/windowDisplayedStore\.init\(\)/);
  });
});
