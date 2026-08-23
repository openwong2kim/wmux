/**
 * Stash-awareness invariants for the teardown / reconcile / save paths (#977).
 *
 * A stashed pane is owned by its workspace and its daemon session is still
 * running, so every path that asks "what does this workspace hold" must see it.
 * Miss one and the failure is silent in the worst way: an orphaned daemon
 * session burning tokens with no window left that can reach it, or a pane
 * permanently stuck between "never confirmed dead" and "never offered for
 * recovery".
 *
 * These are SOURCE-SCAN guards (house pattern: appLayout.sessionSaveInvariants,
 * Sidebar.companyMode, firstParty). AppLayout and the teardown call sites have
 * no jsdom fixture, and the walks they perform cannot be observed from outside.
 * A source pin cannot prove behavior — which is exactly why the DERIVED-liveness
 * transition, the one thing a scan would miss entirely, gets a real end-to-end
 * test in paneSlice.stash.reconcile.test.ts instead.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const RENDERER = path.join(__dirname, '..', '..', '..');

function read(...parts: string[]): string {
  return fs.readFileSync(path.join(RENDERER, ...parts), 'utf-8');
}

describe('AppLayout — reconcile walks everything the workspace owns', () => {
  const source = read('components', 'Layout', 'AppLayout.tsx');

  function reconcileRegion(): string {
    const start = source.indexOf('const reconcilePtys');
    expect(start, 'reconcilePtys not found').toBeGreaterThanOrEqual(0);
    const end = source.indexOf('reconcileInFlightRef.current = run;', start);
    return source.slice(start, end > 0 ? end : start + 20000);
  }

  it('stage 1 collects from getWorkspaceLeafPanes, not the visible tree', () => {
    // Miss this and a stashed PTY never gets a liveness check: it is never
    // confirmed dead, never offered for recovery, and the `exited` state the
    // roster reports is never reached for ANY pane.
    const region = reconcileRegion();
    expect(region).toMatch(/for \(const leaf of getWorkspaceLeafPanes\(ws\)\)/);
    expect(region).not.toMatch(/collect\(ws\.rootPane\)/);
  });

  it('the empty-list guard counts stashed ptyIds as saved', () => {
    // preserveUnconfirmedOnEmpty exists so a not-yet-ready daemon cannot wipe
    // every session. A workspace whose only saved ptyIds are stashed must still
    // trip it.
    expect(reconcileRegion()).toMatch(/hasSavedPtyIds[\s\S]{0,200}getWorkspaceLeafPanes\(ws\)/);
  });

  it('the stage-2 CAS re-query is workspace-wide', () => {
    // The decision may name a stashed pane. A visible-tree re-query would report
    // it as "gone" and SKIP every clear — the liveness model would compile,
    // ship, and never once fire.
    const region = reconcileRegion();
    expect(region).toMatch(/getWorkspaceLeafPanes\(ws\)\.find\(\(l\) => l\.id === a\.paneId\)/);
  });

  it('promotion prefers visible panes across workspaces', () => {
    // Promotion competes for the daemon's limited live-session slots. A session
    // the user cannot see must never take one from a session they are looking at.
    const region = reconcileRegion();
    expect(region).toMatch(/absentCandidates\.sort\(\(a, b\) => Number\(a\.stashed\) - Number\(b\.stashed\)\)/);
    const sortAt = region.indexOf('absentCandidates.sort(');
    const promoteAt = region.indexOf('window.electronAPI?.pty?.promote');
    expect(sortAt).toBeGreaterThanOrEqual(0);
    expect(promoteAt).toBeGreaterThan(sortAt);
  });

  it('buildSessionData sanitizes stashed panes instead of spreading them raw', () => {
    // `...ws` would carry stashedPanes through untouched, skipping the
    // scrollback sanitization every visible pane gets.
    expect(source).toMatch(/stashedPanes: cloneStashedPanes\(ws, dumped\)/);
  });

  it('a stash entry that fails to serialize is degraded, never dropped', () => {
    // A dropped entry is a permanently lost pane PLUS an orphaned session —
    // strictly worse than a failed save, which leaves the previous file intact.
    const start = source.indexOf('function cloneStashedPanes');
    expect(start).toBeGreaterThanOrEqual(0);
    const region = source.slice(start, source.indexOf('/** Build a consistent SessionData', start));
    expect(region).toContain('catch (err)');
    expect(region).toMatch(/\[wmux:stash\] serialize failed/);
    // The fallback builds a minimal entry; it does NOT return undefined/filter.
    expect(region).toMatch(/return \{\s*pane: \{/);
    expect(region).not.toMatch(/\.filter\(/);
  });

  it('builds every snapshot from LIVE state, so an autosave cannot race a stash', () => {
    // The 5s autosave and the synchronous saveSessionNow both call
    // buildSessionData, and it reads useStore.getState() at call time rather
    // than closing over a snapshot. That is what makes the interleave safe: a
    // tick that fires just after a stash writes the post-stash tree, never a
    // half-updated one it captured earlier.
    const start = source.indexOf('function buildSessionData');
    const region = source.slice(start, start + 400);
    expect(region).toMatch(/const state = useStore\.getState\(\);/);
  });

  it('the scrollback dump stays rootPane-only, with the reason recorded', () => {
    // Intentional exclusion: a stashed pane's terminal is unmounted, so it has
    // no terminalRegistry entry — and stashing requires a daemon, which returns
    // from that function before this line.
    const start = source.indexOf('function dumpScrollbackBuffersSync');
    const region = source.slice(start, source.indexOf('/** Deep-clone pane tree', start));
    expect(region).toMatch(/rootPane only, deliberately \(#977\)/);
    expect(region).toContain('collectTerminalSurfaces(ws.rootPane)');
  });
});

describe('teardown paths dispose everything the workspace owns', () => {
  it.each([
    ['Sidebar close button', read('components', 'Sidebar', 'Sidebar.tsx')],
    ['Settings reset-everything', read('components', 'Settings', 'SettingsPanel.tsx')],
    ['keyboard workspace kill', read('hooks', 'useKeyboard.ts')],
  ])('%s uses getWorkspacePtyIds', (_name, source) => {
    // Every one of these kills a whole workspace. A stashed session that
    // survives it is an orphan nothing can reach.
    expect(source).toMatch(/getWorkspacePtyIds\(/);
  });

  it('useKeyboard has no remaining visible-tree-only dispose walk', () => {
    const source = read('hooks', 'useKeyboard.ts');
    // Ctrl+Shift+W and prefix-killWorkspace both tear down a WORKSPACE; only
    // the close-active-pane path (Ctrl+Shift+Q / prefix-x) is tree-scoped, and
    // it acts on a single visible leaf.
    const workspaceKills = source.match(/removeWorkspace\(state\.activeWorkspaceId\)/g) ?? [];
    expect(workspaceKills.length).toBe(2);
    const perKill = source.split('removeWorkspace(state.activeWorkspaceId)');
    for (const before of perKill.slice(0, -1)) {
      expect(before.slice(-600)).toMatch(/getWorkspacePtyIds\(ws\)/);
    }
  });
});

describe('surfaceSlice write seams reach stashed panes', () => {
  const source = read('stores', 'slices', 'surfaceSlice.ts');

  it('updateSurfacePtyId resolves across the whole workspace', () => {
    // THE write seam. Widening only the readers would have made the feature look
    // correct and behave broken: reconcile decides a stashed pty is dead, calls
    // this to clear it, the lookup misses, the CAS logs SKIP, and the derived
    // `exited` state never arrives for any pane.
    // lastIndexOf: the first hit is the interface declaration, not the impl.
    const start = source.lastIndexOf('updateSurfacePtyId:');
    const region = source.slice(start, source.indexOf('updateSurfaceTitle:', start));
    expect(region).toMatch(/findOwnedLeafPane\(ws, paneId\)/);
  });

  it.each(['updateSurfaceTitle', 'updateSurfaceCwd', 'updateSurfaceTitleByPty'])(
    '%s walks getWorkspaceLeafPanes',
    (fn) => {
      const start = source.lastIndexOf(`${fn}:`);
      const region = source.slice(start, start + 900);
      expect(region).toMatch(/getWorkspaceLeafPanes\(ws\)/);
    },
  );
});
