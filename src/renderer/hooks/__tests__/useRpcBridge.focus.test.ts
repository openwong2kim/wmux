import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Workspace-scoping wiring for the address-resolution focus paths
 * (issue #236 follow-up — the last sibling after surface.new / pane.close).
 *
 * pane.focus / surface.focus used to act on the UI-ACTIVE workspace only:
 *   - pane.focus called store.setActivePane(id) directly, which silently no-ops
 *     for any non-active workspace yet still returned {ok:true} (false success);
 *   - surface.focus searched store.activeWorkspaceId only → "surface not found"
 *     for a background workspace.
 * Both now resolve the globally-unique id across ALL workspaces (mirroring the
 * #256 pane.close / surface.close handlers) and delegate the mutation to the
 * dedicated, non-yank focusPaneSurface store action — so an external agent can
 * focus its own background pane/surface without stealing the user's screen.
 *
 * The behavioural assertions (activePaneId moves, activeWorkspaceId UNCHANGED,
 * emit on real change, no mutation/emit on a branch id) live in
 * paneSlice.events.test.ts against focusPaneSurface — the action holds all the
 * mutation logic. handleRpcMethod is not exported and pulls in the store/window,
 * so it can't be imported under vitest (same constraint as
 * useRpcBridge.browserClose.test.ts / useRpcBridge.a2aPaneIdentity.test.ts);
 * these are source-structural guards that the handlers stay wired to the all-ws
 * resolver + focusPaneSurface and keep the {error}-on-miss contract.
 */
describe('useRpcBridge — focus-path workspace scoping (#236 follow-up)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'useRpcBridge.ts'), 'utf-8');

  function region(start: string, end: string): string {
    const m = src.match(new RegExp(`${start}[\\s\\S]*?${end}`));
    if (!m) {
      throw new Error(
        `region ${start} → ${end} not found in useRpcBridge.ts. ` +
          'Update the regex if the handler layout changed.',
      );
    }
    return m[0];
  }

  describe('pure resolver helpers', () => {
    it('defines findOwningWorkspace as an all-workspaces scan by paneId', () => {
      const block = region('function findOwningWorkspace\\(', 'function findOwningWorkspaceBySurface');
      expect(block).toMatch(/for \(const ws of workspaces\)/);
      expect(block).toMatch(/findPaneById\(ws\.rootPane, paneId\)/);
    });

    it('defines findOwningWorkspaceBySurface returning the owning ws + leaf', () => {
      const block = region('function findOwningWorkspaceBySurface\\(', '// ----');
      expect(block).toMatch(/for \(const ws of workspaces\)/);
      expect(block).toMatch(/findLeafBySurfaceId\(ws\.rootPane, surfaceId\)/);
      expect(block).toMatch(/return \{ ws, leaf \}/);
    });
  });

  describe('pane.focus', () => {
    function block(): string {
      return region("method === 'pane\\.focus'", "method === 'pane\\.split'");
    }

    it('resolves the owning workspace across ALL workspaces (not activeWorkspaceId)', () => {
      const b = block();
      expect(b).toMatch(/findOwningWorkspace\(store\.workspaces, paneId\)/);
      // The resolver, not the active workspace, decides the target → no
      // store.activeWorkspaceId read in this handler (non-yank by construction).
      expect(b).not.toMatch(/store\.activeWorkspaceId/);
    });

    it('returns {error} when the pane belongs to no workspace (false-ok removed)', () => {
      const b = block();
      expect(b).toMatch(/if \(!ownerWs\) return \{ error:/);
      // The old direct no-op call is gone.
      expect(b).not.toMatch(/store\.setActivePane\(paneId\)/);
    });

    it('delegates to focusPaneSurface(ownerWs.id, paneId) and {error}s a non-leaf', () => {
      const b = block();
      expect(b).toMatch(/store\.focusPaneSurface\(ownerWs\.id, paneId\)/);
      // focusPaneSurface returns false for a branch/missing id → surfaced as error.
      expect(b).toMatch(/if \(!ok\) return \{ error:/);
    });
  });

  describe('surface.focus', () => {
    function block(): string {
      return region("method === 'surface\\.focus'", "method === 'pane\\.close'");
    }

    it('resolves the owning workspace + leaf across ALL workspaces (not activeWorkspaceId)', () => {
      const b = block();
      expect(b).toMatch(/findOwningWorkspaceBySurface\(store\.workspaces, surfaceId\)/);
      // No active-workspace lookup → non-yank, and no "no active workspace" path.
      expect(b).not.toMatch(/store\.activeWorkspaceId/);
      expect(b).not.toMatch(/no active workspace/);
    });

    it('returns {error} when the surface belongs to no workspace', () => {
      const b = block();
      expect(b).toMatch(/if \(!owner\) return \{ error:/);
    });

    it('delegates the active pane + surface set to focusPaneSurface in one call', () => {
      const b = block();
      expect(b).toMatch(/store\.focusPaneSurface\(owner\.ws\.id, owner\.leaf\.id, surfaceId\)/);
      // The two-write setActivePane + setActiveSurface pair is replaced by the
      // single atomic action.
      expect(b).not.toMatch(/store\.setActivePane\(/);
      expect(b).not.toMatch(/store\.setActiveSurface\(/);
    });
  });
});
