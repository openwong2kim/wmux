import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PANE_ACTIONS_CLUSTER_WIDTH,
  PANE_ACTIONS_MIN_PANE_WIDTH,
  MIN_TAB_STRIP_WIDTH,
  paneClusterWidth,
  paneFitsActionCluster,
} from '../SurfaceTabs';

describe('paneClusterWidth', () => {
  it('reports the cluster constant when pane actions show', () => {
    expect(paneClusterWidth({ paneActionsVisible: true })).toBe(PANE_ACTIONS_CLUSTER_WIDTH);
  });

  it('is zero when the cluster is off', () => {
    expect(paneClusterWidth({ paneActionsVisible: false })).toBe(0);
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
    const start = source.indexOf('{paneActionsVisible && (');
    expect(start, 'pane action cluster not found').toBeGreaterThanOrEqual(0);
    // The cluster is the last thing the component renders; everything after it
    // is closing markup, which carries no data-pane-action attributes.
    return source.slice(start);
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
