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
 * Fix: the handler snapshots whether this was the last surface BEFORE closing,
 * then cascades into closePane — mirroring the UI path. (Root panes are a no-op
 * in closePane by design, so a browser that is a workspace's only pane still
 * gets an auto-terminal on both paths; only the non-root asymmetry was a bug.)
 *
 * This is a source-structural test: handleRpcMethod is not exported and pulls in
 * the whole store, so it can't be imported under vitest — the same reason the
 * pty.handler tests scan source. It fails if a refactor drops the cascade or
 * reorders it so the last-surface decision is made AFTER the surface is gone.
 */
describe('useRpcBridge browser.close cascade (issue #143)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'useRpcBridge.ts'),
    'utf-8',
  );

  /** Isolate the browser.close handler region so assertions can't match elsewhere. */
  function closeBlock(): string {
    const match = src.match(
      /method === 'browser\.close'[\s\S]*?method === 'browser\.navigate'/,
    );
    if (!match) {
      throw new Error(
        "browser.close -> browser.navigate handler region not found in " +
          'useRpcBridge.ts. Update the regex if the layout changed.',
      );
    }
    return match[0];
  }

  it('cascades into closePane when the last surface is closed', () => {
    const block = closeBlock();
    expect(block).toMatch(/store\.closeSurface\(/);
    // The empty-pane cleanup that issue #143 was missing.
    expect(block).toMatch(/store\.closePane\(targetLeaf\.id\)/);
  });

  it('decides last-surface BEFORE closeSurface (no off-by-one on the snapshot)', () => {
    const block = closeBlock();
    // The pre-close snapshot must exist and gate the closePane call.
    expect(block).toMatch(/const\s+wasLastSurface\s*=\s*targetLeaf\.surfaces\.length\s*<=\s*1/);
    expect(block).toMatch(/if\s*\(\s*wasLastSurface\s*\)/);

    // Ordering: the length is captured before the surface is spliced out, or the
    // decision would be off-by-one (length already decremented).
    const snapAt = block.indexOf('wasLastSurface =');
    const closeAt = block.indexOf('store.closeSurface(');
    expect(snapAt).toBeGreaterThanOrEqual(0);
    expect(closeAt).toBeGreaterThan(snapAt);
  });
});
