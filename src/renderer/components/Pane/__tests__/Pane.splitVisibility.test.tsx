/**
 * Regression tests for the terminal+browser split blank-pane bug.
 *
 * Symptom: in a pane holding BOTH a terminal and a browser surface,
 * `SplitSurfaceView` lays them out side by side but each surface gated its
 * `display` on `surface.id === activeSurfaceId`. A pane has a single
 * `activeSurfaceId`, so focusing one side display:none'd the other — the
 * non-focused side went blank, toggling as the user switched.
 *
 * Fix: `pickSplitShownSurfaces` decouples visibility (what renders on each
 * side) from focus (`activeSurfaceId`). Each side shows its active surface when
 * the active surface is on that side, else its first surface — so neither side
 * ever blanks. These tests pin that contract.
 *
 * Runs in the repo's node (no-JSDOM) vitest env — same pattern as
 * Pane.notificationRing.test.tsx (the pure helper is the load-bearing piece).
 */
import { describe, it, expect } from 'vitest';
import { pickSplitShownSurfaces, resolveRemoteAttachPaneId, isSplitWorkExpanded, isTerminalKindSurfaceType, isWorkSurfaceType } from '../Pane';

const T = (id: string) => ({ id });

describe('pickSplitShownSurfaces — split visibility decoupled from focus', () => {
  it('common 1 terminal + 1 browser: BOTH sides shown when the terminal is focused', () => {
    const r = pickSplitShownSurfaces([T('term-1')], [T('brow-1')], 'term-1');
    expect(r.shownTerminalId).toBe('term-1');
    // The regression: the browser side must STILL show its surface, not blank.
    expect(r.shownWorkId).toBe('brow-1');
  });

  it('common 1 terminal + 1 browser: BOTH sides shown when the browser is focused', () => {
    const r = pickSplitShownSurfaces([T('term-1')], [T('brow-1')], 'brow-1');
    // The regression in the other direction: the terminal side must not blank.
    expect(r.shownTerminalId).toBe('term-1');
    expect(r.shownWorkId).toBe('brow-1');
  });

  it('neither side blanks for EITHER focus target (the core invariant)', () => {
    const terminals = [T('term-1')];
    const browsers = [T('brow-1')];
    for (const active of ['term-1', 'brow-1']) {
      const r = pickSplitShownSurfaces(terminals, browsers, active);
      expect(r.shownTerminalId).toBeDefined();
      expect(r.shownWorkId).toBeDefined();
    }
  });

  it('multiple terminal tabs: the FOCUSED terminal shows; browser side shows its first', () => {
    const r = pickSplitShownSurfaces([T('term-1'), T('term-2')], [T('brow-1')], 'term-2');
    expect(r.shownTerminalId).toBe('term-2'); // active tab on the terminal side
    expect(r.shownWorkId).toBe('brow-1'); // browser side keeps its first, never blank
  });

  it('multiple browser tabs: the FOCUSED browser shows; terminal side shows its first', () => {
    const r = pickSplitShownSurfaces([T('term-1'), T('term-2')], [T('brow-1'), T('brow-2')], 'brow-2');
    expect(r.shownTerminalId).toBe('term-1'); // terminal side falls back to first (active is a browser)
    expect(r.shownWorkId).toBe('brow-2'); // active browser tab
  });

  it('active surface absent from both lists: each side falls back to its first', () => {
    const r = pickSplitShownSurfaces([T('term-1')], [T('brow-1')], 'stale-id');
    expect(r.shownTerminalId).toBe('term-1');
    expect(r.shownWorkId).toBe('brow-1');
  });

  it('defensive: empty side yields undefined (no throw) without affecting the other', () => {
    expect(pickSplitShownSurfaces([], [T('brow-1')], 'brow-1')).toEqual({
      shownTerminalId: undefined,
      shownWorkId: 'brow-1',
    });
    expect(pickSplitShownSurfaces([T('term-1')], [], 'term-1')).toEqual({
      shownTerminalId: 'term-1',
      shownWorkId: undefined,
    });
  });
});

describe('pane surface kinds — terminal column vs work area', () => {
  it('local and remote terminals, legacy untyped surfaces and mirror placeholders are terminal-kind', () => {
    for (const t of [undefined, 'terminal', 'remote-terminal', 'placeholder']) {
      expect(isTerminalKindSurfaceType(t)).toBe(true);
      expect(isWorkSurfaceType(t)).toBe(false);
    }
  });

  it('browser, editor, preview and diff go to the work area', () => {
    for (const t of ['browser', 'editor', 'preview', 'diff']) {
      expect(isWorkSurfaceType(t)).toBe(true);
      expect(isTerminalKindSurfaceType(t)).toBe(false);
    }
  });

  it('retired git / review surfaces belong to neither side', () => {
    for (const t of ['git', 'review']) {
      expect(isWorkSurfaceType(t)).toBe(false);
      expect(isTerminalKindSurfaceType(t)).toBe(false);
    }
  });
});

describe('pickSplitShownSurfaces — the work side remembers what it last showed', () => {
  it('focusing a terminal keeps the last shown work tab, not the first', () => {
    const r = pickSplitShownSurfaces([T('term-1')], [T('brow-1'), T('edit-1')], 'term-1', 'edit-1');
    expect(r.shownWorkId).toBe('edit-1');
  });

  it('a remembered tab that was closed falls back to the first', () => {
    const r = pickSplitShownSurfaces([T('term-1')], [T('brow-1')], 'term-1', 'gone');
    expect(r.shownWorkId).toBe('brow-1');
  });
});

describe('resolveRemoteAttachPaneId — #1140 split-into-a-pane vs the #1100 tab', () => {
  it('null direction (the #1100 tab flow): always the pane the ⋮ menu opened on, regardless of splitResult', () => {
    // splitPane is never even called on this path — the caller passes the
    // clicking pane's own id as a placeholder, which must be ignored in favor
    // of currentPaneId if it ever WAS read.
    expect(resolveRemoteAttachPaneId(null, 'pane-A', 'pane-A')).toBe('pane-A');
    expect(resolveRemoteAttachPaneId(null, 'pane-A', false)).toBe('pane-A');
  });

  it('a direction (the new split flow): targets the NEW pane splitPane returned, not the one that was split', () => {
    expect(resolveRemoteAttachPaneId('horizontal', 'pane-A', 'pane-B')).toBe('pane-B');
    expect(resolveRemoteAttachPaneId('vertical', 'pane-A', 'pane-B')).toBe('pane-B');
  });

  it('a direction but splitPane was blocked (per-workspace pane cap): attach nowhere, never fall back to the original pane', () => {
    // Falling back to pane-A here would silently put a second surface on a
    // pane the user explicitly asked to split away from — worse than doing
    // nothing, since the cap warning already told them why the split refused.
    expect(resolveRemoteAttachPaneId('horizontal', 'pane-A', false)).toBeNull();
  });
});

describe('isSplitWorkExpanded — #2140 the work area fills the pane', () => {
  it('expands while a browser is active and both sides exist', () => {
    expect(isSplitWorkExpanded(true, [T('term-1')], [T('brow-1')], 'brow-1')).toBe(true);
    expect(isSplitWorkExpanded(false, [T('term-1')], [T('brow-1')], 'brow-1')).toBe(false);
  });

  it('an active terminal is never hidden, in the same render that activates it', () => {
    expect(isSplitWorkExpanded(true, [T('term-1'), T('term-2')], [T('brow-1')], 'term-2')).toBe(false);
  });

  it('losing either side drops the mode', () => {
    expect(isSplitWorkExpanded(true, [], [T('brow-1')], 'brow-1')).toBe(false);
    expect(isSplitWorkExpanded(true, [T('term-1')], [], 'term-1')).toBe(false);
  });
});
