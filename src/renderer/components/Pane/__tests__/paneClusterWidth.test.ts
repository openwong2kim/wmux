import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PANE_ACTIONS_CLUSTER_WIDTH,
  PANE_ACTIONS_MIN_PANE_WIDTH,
  PANE_ACTIONS_OVERFLOW_WIDTH,
  MIN_TAB_STRIP_WIDTH,
  paneClusterWidth,
  paneActionsMode,
  paneFitsActionCluster,
} from '../SurfaceTabs';

describe('paneClusterWidth', () => {
  it('reports the cluster constant when pane actions show', () => {
    expect(paneClusterWidth({ mode: 'full' })).toBe(PANE_ACTIONS_CLUSTER_WIDTH);
  });

  it('reports the ⋮ trigger width when the cluster is collapsed', () => {
    expect(paneClusterWidth({ mode: 'overflow' })).toBe(PANE_ACTIONS_OVERFLOW_WIDTH);
  });

  it('is zero when the cluster is off', () => {
    expect(paneClusterWidth({ mode: 'none' })).toBe(0);
  });
});

// ─── The constant vs. the markup it claims to measure ───────────────────────
//
// PANE_ACTIONS_CLUSTER_WIDTH is a hand-computed pixel total, and Pane.tsx
// positions the supervision badge from it. Importing the constant (as the tests
// above do) can never catch the failure that actually happens: someone adds a
// button, the number silently stops describing the markup, and the badge drifts
// under the cluster with every test still green. This derives the width from the
// rendered button count instead, so the arithmetic and the JSX have to move
// together — which is exactly what the stash button (#977) required.
describe('PANE_ACTIONS_CLUSTER_WIDTH tracks the cluster markup', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'SurfaceTabs.tsx'),
    'utf-8',
  );

  function clusterRegion(): string {
    const start = source.indexOf("{mode === 'full' && (");
    expect(start, 'pane action cluster not found').toBeGreaterThanOrEqual(0);
    // Stop at the collapsed cluster that follows it, so the ⋮ trigger's markup
    // is never counted as a sixth action button.
    const end = source.indexOf("{mode === 'overflow' && (", start);
    expect(end, 'overflow cluster not found').toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it('equals the geometry of the buttons actually rendered', () => {
    const region = clusterRegion();
    const buttons = (region.match(/data-pane-action="/g) ?? []).length;
    expect(buttons).toBeGreaterThan(0);

    //   outer div  border-l 1 + pl-1 4 ................ 5
    //   N x w-6 buttons (24 each)
    //   (N-1) x gap-0.5 (2 each)
    //   zoom wrapper  ml-0.5 2 + border-l 1 + pl-1 4 ... 7
    //   outer div  pr-0.5 2 ............................ 2
    const expected = 5 + buttons * 24 + (buttons - 1) * 2 + 7 + 2;
    expect(PANE_ACTIONS_CLUSTER_WIDTH).toBe(expected);
  });

  it('has the doc comment agree with the constant', () => {
    // The comment IS the derivation; a stale one is how the number goes wrong.
    const doc = source.slice(0, source.indexOf('export const PANE_ACTIONS_CLUSTER_WIDTH'));
    expect(doc).toContain(`total = ${PANE_ACTIONS_CLUSTER_WIDTH}`);
  });
});

// ─── Width-based auto-collapse ──────────────────────────────────────────────
//
// The cluster is fixed-width and shrink-0; the tab strip beside it is flex-1
// min-w-0. So on a narrow pane the strip does not shrink gracefully, it
// collapses to NOTHING — at ~200px the header was 100% buttons and 0% identity,
// with the last button clipped. Below the threshold the pane falls back to the
// existing cluster-off chrome instead.

describe('paneFitsActionCluster', () => {
  it('derives the threshold from the cluster, never a second hardcoded number', () => {
    expect(PANE_ACTIONS_MIN_PANE_WIDTH).toBe(PANE_ACTIONS_CLUSTER_WIDTH + MIN_TAB_STRIP_WIDTH);
  });

  it('keeps the cluster at and above the threshold', () => {
    expect(paneFitsActionCluster(PANE_ACTIONS_MIN_PANE_WIDTH)).toBe(true);
    expect(paneFitsActionCluster(PANE_ACTIONS_MIN_PANE_WIDTH + 400)).toBe(true);
  });

  it('drops it below the threshold — the reported ~200px case', () => {
    expect(paneFitsActionCluster(PANE_ACTIONS_MIN_PANE_WIDTH - 1)).toBe(false);
    expect(paneFitsActionCluster(200)).toBe(false);
  });

  it('keeps the cluster while unmeasured, so mounting does not flash the fallback', () => {
    expect(paneFitsActionCluster(null)).toBe(true);
  });

  it('treats a zero width as hidden, not narrow', () => {
    // A pane in a background workspace measures 0. Collapsing its chrome would
    // be a change the user never sees happen and then sees undone.
    expect(paneFitsActionCluster(0)).toBe(true);
  });

  it('leaves room for the identity the strip exists to show', () => {
    // The floor is a real budget: coordinate + truncated title + ✕.
    expect(MIN_TAB_STRIP_WIDTH).toBeGreaterThanOrEqual(64);
  });
});

// ─── The collapsed cluster ──────────────────────────────────────────────────
//
// 111px to 222px is a real, reachable band: a 1536px screen with the deck open
// leaves the grid ~996px, so a five-way horizontal split lands at ~199px, and
// the resize handles go lower still (Panel minSize is 10%). Dropping every
// action there removed them exactly when a crowded layout needs stash and zoom
// most — and "add a browser tab to THIS pane" had no other entry point at all.

describe('PANE_ACTIONS_OVERFLOW_WIDTH tracks the ⋮ markup', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'SurfaceTabs.tsx'),
    'utf-8',
  );

  it('equals the geometry of the collapsed cluster', () => {
    const start = source.indexOf("{mode === 'overflow' && (");
    expect(start, 'overflow cluster not found').toBeGreaterThanOrEqual(0);
    const region = source.slice(start);
    // One trigger, never more: the whole point is that it costs one button.
    const triggers = (region.match(/data-pane-overflow-trigger/g) ?? []).length;
    expect(triggers).toBe(1);

    //   outer div  border-l 1 + pl-1 4 ... 5
    //   1 x w-6 button ................... 24
    //   outer div  pr-0.5 2 ............... 2
    expect(PANE_ACTIONS_OVERFLOW_WIDTH).toBe(5 + 24 + 2);
  });

  it('has no gap-0.5 to pay for — there is nothing to space', () => {
    // The full cluster's 4 gaps are 8 of its 142px. A one-child flex row that
    // still declared `gap` would make the constant wrong by exactly nothing
    // today and by 2px per button the moment someone adds a second one.
    const start = source.indexOf("{mode === 'overflow' && (");
    const region = source.slice(start, source.indexOf('</div>', start));
    expect(region).not.toContain('gap-0.5');
  });
});

describe('paneActionsMode', () => {
  it('keeps the full cluster at and above its threshold', () => {
    expect(paneActionsMode(PANE_ACTIONS_MIN_PANE_WIDTH)).toBe('full');
    expect(paneActionsMode(PANE_ACTIONS_MIN_PANE_WIDTH + 400)).toBe('full');
  });

  it('collapses to ⋮ below the threshold', () => {
    expect(paneActionsMode(PANE_ACTIONS_MIN_PANE_WIDTH - 1)).toBe('overflow');
    expect(paneActionsMode(200)).toBe('overflow');
  });

  it('never gives up by width — the ⋮ persists however narrow the pane gets', () => {
    // Below ~111px the ⋮ eats into MIN_TAB_STRIP_WIDTH, but the strip scrolls,
    // so identity stays reachable — while the menu holds the only ways OUT of
    // a pane this narrow (zoom, stash). `none` is the Settings toggle's mode,
    // never a width verdict.
    for (const w of [PANE_ACTIONS_OVERFLOW_WIDTH + MIN_TAB_STRIP_WIDTH - 1, 98, 40, PANE_ACTIONS_OVERFLOW_WIDTH, 10]) {
      expect(paneActionsMode(w)).toBe('overflow');
    }
  });

  it('agrees with paneFitsActionCluster, which is its `full` arm', () => {
    for (const w of [null, 0, 40, 110, 111, 200, 221, 222, 600]) {
      expect(paneFitsActionCluster(w)).toBe(paneActionsMode(w) === 'full');
    }
  });

  it('keeps the full cluster while unmeasured or hidden', () => {
    // Unmeasured: assuming narrow would flash collapsed chrome on every mount.
    // Zero: a background workspace, not a narrow pane — collapsing there is a
    // change the user never sees happen and then sees undone.
    expect(paneActionsMode(null)).toBe('full');
    expect(paneActionsMode(0)).toBe('full');
  });
});

// ─── The two surfaces must offer the SAME actions ───────────────────────────
//
// The cluster and the menu are separate markup, so nothing but this stops the
// next action from landing on one and not the other — which is the failure the
// menu exists to prevent (a narrow pane silently losing an action).

describe('the ⋮ menu offers exactly what the cluster does', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'SurfaceTabs.tsx'),
    'utf-8',
  );

  function clusterActions(): string[] {
    const start = source.indexOf("{mode === 'full' && (");
    const end = source.indexOf("{mode === 'overflow' && (", start);
    const region = source.slice(start, end);
    return [...region.matchAll(/data-pane-action="([a-z-]+)"/g)].map((m) => m[1]).sort();
  }

  function menuActions(): string[] {
    const start = source.indexOf('const menuItems: PaneActionItem[]');
    expect(start, 'menuItems not found').toBeGreaterThanOrEqual(0);
    const end = source.indexOf('], [', start);
    const region = source.slice(start, end);
    return [...region.matchAll(/key: '([a-z-]+)'/g)].map((m) => m[1]).sort();
  }

  it('offers every cluster action in the menu, and pins the menu-only set', () => {
    const cluster = clusterActions();
    expect(cluster.length).toBeGreaterThan(0);
    const menu = menuActions();
    // The failure this guards is directional: the menu is the surface that
    // must never LOSE an action, because at a width where only the ⋮ (or the
    // header right-click) fits, the menu is all the user has. The menu may
    // carry more — pinned exactly, so a menu-only addition is a deliberate
    // decision here rather than silent drift. rename-pane is menu-only by
    // design (#1021): the label fold removed the double-click target on
    // unnamed single-tab panes, and the menu replaces that affordance; the
    // cluster keeps to icon-sized layout actions. new-remote (#1086/#1091) is
    // the same kind of deliberate menu-only addition, conditionally rendered
    // (only when a caller passes onAddRemote) rather than promoted to the
    // icon cluster. split-right-remote / split-down-remote (#1140) are the
    // same pattern again — conditionally rendered on onSplitHorizontalRemote
    // / onSplitVerticalRemote, menu-only rather than icon cluster.
    for (const key of cluster) expect(menu).toContain(key);
    expect(menu.filter((k) => !cluster.includes(k))).toEqual([
      'new-remote', 'rename-pane', 'split-down-remote', 'split-right-remote',
    ]);
  });
});
