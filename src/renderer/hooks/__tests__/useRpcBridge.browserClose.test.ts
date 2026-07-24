import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Regression test for issue #143: MCP browser_close left an empty pane that
 * AppLayout backfilled with a fresh terminal.
 *
 * Root cause: the UI close path (Pane.tsx handleCloseSurface) removes the pane
 * when its last surface is closed (closeSurface then closePane), but the MCP
 * mirror (browser.close in useRpcBridge.ts) only called closeSurface, leaving a
 * surfaces.length === 0 leaf that the "auto-create initial surface for empty
 * leaf panes" effect then filled with a terminal. browser_open/close in a loop
 * accreted blank terminals.
 *
 * Fix: the shared browser-tabs close helper snapshots whether this was the last
 * surface BEFORE closing, then cascades into closePane — mirroring the UI path.
 * (Root panes are a no-op in closePane by design, so a browser that is a
 * workspace's only pane still gets an auto-terminal on both paths; only the
 * non-root asymmetry was a bug.)
 *
 * This is a source-structural test: handleRpcMethod is not exported and pulls in
 * the whole store, so it can't be imported under vitest — the same reason the
 * pty.handler tests scan source. It fails if a refactor drops the cascade or
 * reorders it so the last-surface decision is made AFTER the surface is gone.
 */
describe('useRpcBridge browser.close cascade (issue #143)', () => {
  const closeHelperSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'utils', 'browserTabs.ts'),
    'utf-8',
  );

  /** Isolate the shared close helper so assertions cannot match another path. */
  function closeHelperBlock(): string {
    const match = closeHelperSrc.match(
      /export function closeBrowserTabInWorkspace[\s\S]*?^}/m,
    );
    if (!match) {
      throw new Error(
        'closeBrowserTabInWorkspace helper not found in browserTabs.ts. ' +
          'Update the regex if the layout changed.',
      );
    }
    return match[0];
  }

  it('cascades into closePane ONLY inside the wasLastSurface branch', () => {
    const block = closeHelperBlock();
    expect(block).toMatch(/state\.closeSurface\(/);
    // The empty-pane cleanup that issue #143 was missing — and it has to stay
    // INSIDE the guard. Asserting `if (wasLastSurface)` and the closePane call
    // as two independent matches would still pass if a rewrite hoisted
    // closePane out of the branch, which would tear down panes the browser
    // merely shares with a terminal.
    expect(block).toMatch(
      /if\s*\(\s*wasLastSurface\s*\)\s*\{\s*state\.closePane\(\s*target\.pane\.id,\s*target\.workspace\.id,?\s*\);?\s*\}/,
    );
  });

  it('decides last-surface BEFORE closeSurface (no off-by-one on the snapshot)', () => {
    const block = closeHelperBlock();
    // The pre-close snapshot must exist and gate the closePane call.
    expect(block).toMatch(/const\s+wasLastSurface\s*=\s*target\.pane\.surfaces\.length\s*<=\s*1/);
    expect(block).toMatch(/if\s*\(\s*wasLastSurface\s*\)/);

    // Ordering: the length is captured before the surface is spliced out, or the
    // decision would be off-by-one (length already decremented).
    const snapAt = block.indexOf('wasLastSurface =');
    const closeAt = block.indexOf('state.closeSurface(');
    const paneAt = block.indexOf('state.closePane(');
    expect(snapAt).toBeGreaterThanOrEqual(0);
    expect(closeAt).toBeGreaterThan(snapAt);
    // ...and the pane teardown follows the surface removal. Reversing them
    // would close the leaf while it still holds the surface.
    expect(paneAt).toBeGreaterThan(closeAt);
  });
});

/**
 * Workspace-routing invariants for the close paths (X4 follow-up).
 *
 * browser.close used to resolve "the browser pane" inside the UI-ACTIVE
 * workspace only, while browser.open had been fixed (#193) to honor the
 * caller's workspaceId. The asymmetry meant an agent in workspace A issuing
 * a surfaceId-less close tore down whatever browser the user was viewing in
 * workspace B — or got a spurious "not found" when B had none.
 *
 * surface.close had the sibling false-negative: an explicit (globally unique)
 * surface id outside the active workspace returned "surface not found".
 */
describe('useRpcBridge close-path workspace routing', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'useRpcBridge.ts'),
    'utf-8',
  );

  function blockBetween(startMarker: string, endMarker: string): string {
    const match = src.match(
      new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`),
    );
    if (!match) {
      throw new Error(
        `${startMarker} -> ${endMarker} handler region not found in ` +
          'useRpcBridge.ts. Update the regex if the layout changed.',
      );
    }
    return match[0];
  }

  it('browser.close honors params.workspaceId with an active-workspace fallback (mirrors browser.open)', () => {
    const block = blockBetween("method === 'browser\\.close'", "method === 'browser\\.navigate'");
    expect(block).toMatch(/params\.workspaceId/);
    expect(block).toMatch(/store\.activeWorkspaceId/);
    // The store mutations must be pinned to the RESOLVED workspace, or the
    // slice-level active-workspace default silently no-ops on background ones.
    expect(block).toMatch(/closeBrowserTabInWorkspace\(store,\s*targetWs\.id,\s*targetSurfaceId\)/);
  });

  it('browser.close with an explicit surfaceId searches every workspace (unambiguous target)', () => {
    const block = blockBetween("method === 'browser\\.close'", "method === 'browser\\.navigate'");
    expect(block).toMatch(/for \(const ws of store\.workspaces\)/);
  });

  it('surface.close resolves an explicit surface id across all workspaces', () => {
    const block = blockBetween("method === 'surface\\.close'", "method === 'pane\\.list'");
    expect(block).toMatch(/for \(const ws of store\.workspaces\)/);
    expect(block).toMatch(/store\.closeSurface\(targetLeaf\.id,\s*surfaceId,\s*targetWs\.id\)/);
  });

  it('browser.tabs delegates to the workspace-exact renderer helper', () => {
    const block = blockBetween("method === 'browser\\.tabs'", "method === 'browser\\.open'");
    expect(block).toMatch(/handleBrowserTabsRpc\(params/);
    expect(block).toMatch(/getState:\s*\(\)\s*=>\s*useStore\.getState\(\)/);
  });
});
