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
import { pickSplitShownSurfaces, pickOverlaySurfaces, resolveRemoteAttachPaneId } from '../Pane';

const T = (id: string) => ({ id });

describe('pickSplitShownSurfaces — split visibility decoupled from focus', () => {
  it('common 1 terminal + 1 browser: BOTH sides shown when the terminal is focused', () => {
    const r = pickSplitShownSurfaces([T('term-1')], [T('brow-1')], 'term-1');
    expect(r.shownTerminalId).toBe('term-1');
    // The regression: the browser side must STILL show its surface, not blank.
    expect(r.shownBrowserId).toBe('brow-1');
  });

  it('common 1 terminal + 1 browser: BOTH sides shown when the browser is focused', () => {
    const r = pickSplitShownSurfaces([T('term-1')], [T('brow-1')], 'brow-1');
    // The regression in the other direction: the terminal side must not blank.
    expect(r.shownTerminalId).toBe('term-1');
    expect(r.shownBrowserId).toBe('brow-1');
  });

  it('neither side blanks for EITHER focus target (the core invariant)', () => {
    const terminals = [T('term-1')];
    const browsers = [T('brow-1')];
    for (const active of ['term-1', 'brow-1']) {
      const r = pickSplitShownSurfaces(terminals, browsers, active);
      expect(r.shownTerminalId).toBeDefined();
      expect(r.shownBrowserId).toBeDefined();
    }
  });

  it('multiple terminal tabs: the FOCUSED terminal shows; browser side shows its first', () => {
    const r = pickSplitShownSurfaces([T('term-1'), T('term-2')], [T('brow-1')], 'term-2');
    expect(r.shownTerminalId).toBe('term-2'); // active tab on the terminal side
    expect(r.shownBrowserId).toBe('brow-1'); // browser side keeps its first, never blank
  });

  it('multiple browser tabs: the FOCUSED browser shows; terminal side shows its first', () => {
    const r = pickSplitShownSurfaces([T('term-1'), T('term-2')], [T('brow-1'), T('brow-2')], 'brow-2');
    expect(r.shownTerminalId).toBe('term-1'); // terminal side falls back to first (active is a browser)
    expect(r.shownBrowserId).toBe('brow-2'); // active browser tab
  });

  it('active surface absent from both lists: each side falls back to its first', () => {
    const r = pickSplitShownSurfaces([T('term-1')], [T('brow-1')], 'stale-id');
    expect(r.shownTerminalId).toBe('term-1');
    expect(r.shownBrowserId).toBe('brow-1');
  });

  it('defensive: empty side yields undefined (no throw) without affecting the other', () => {
    expect(pickSplitShownSurfaces([], [T('brow-1')], 'brow-1')).toEqual({
      shownTerminalId: undefined,
      shownBrowserId: 'brow-1',
    });
    expect(pickSplitShownSurfaces([T('term-1')], [], 'term-1')).toEqual({
      shownTerminalId: 'term-1',
      shownBrowserId: undefined,
    });
  });
});

// F6 — split(terminal+browser) 혼재 페인에서 diff·editor가 누락되지 않아야 한다.
describe('pickOverlaySurfaces — F6 mixed-split diff/editor routing', () => {
  it('terminal+browser+diff 혼재에서 diff 서피스를 오버레이 집합으로 추출', () => {
    const surfaces = [
      { id: 's1', surfaceType: 'terminal' },
      { id: 's2', surfaceType: 'browser' },
      { id: 's3', surfaceType: 'diff' },
    ];
    const overlay = pickOverlaySurfaces(surfaces);
    // 스플릿이 terminals·browsers만 렌더하므로 diff는 오버레이로 별도 라우팅돼야 한다.
    expect(overlay.map((s) => s.id)).toEqual(['s3']);
  });

  it('editor도 오버레이 집합에 포함(diff와 동일 처리)', () => {
    const surfaces = [
      { id: 't', surfaceType: 'terminal' },
      { id: 'b', surfaceType: 'browser' },
      { id: 'e', surfaceType: 'editor' },
      { id: 'd', surfaceType: 'diff' },
    ];
    expect(pickOverlaySurfaces(surfaces).map((s) => s.id)).toEqual(['e', 'd']);
  });

  it('순수 terminal/browser만이면 오버레이 없음(회귀 방지)', () => {
    const surfaces = [
      { id: 't', surfaceType: 'terminal' },
      { id: 'b', surfaceType: 'browser' },
      { id: 'legacy', surfaceType: undefined },
    ];
    expect(pickOverlaySurfaces(surfaces)).toEqual([]);
  });

  it('git·review는 오버레이 집합에서 제외(2026-07-20 워크스페이스 헤더로 이관)', () => {
    // 페인 surface 폐지 후 git/review는 페인 오버레이가 아니라 중앙 표면으로 산다.
    const surfaces = [
      { id: 't', surfaceType: 'terminal' },
      { id: 'g', surfaceType: 'git' },
      { id: 'r', surfaceType: 'review' },
    ];
    expect(pickOverlaySurfaces(surfaces)).toEqual([]);
  });

  it('#1100 CodeRabbit round 1 — remote-terminal도 오버레이 집합에 포함 (terminal+browser+remote 혼재에서 사라지지 않아야 함)', () => {
    const surfaces = [
      { id: 't', surfaceType: 'terminal' },
      { id: 'b', surfaceType: 'browser' },
      { id: 'r', surfaceType: 'remote-terminal' },
    ];
    expect(pickOverlaySurfaces(surfaces).map((s) => s.id)).toEqual(['r']);
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
