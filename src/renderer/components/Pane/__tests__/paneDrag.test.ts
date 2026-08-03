// @vitest-environment jsdom
//
// Issue #645 — drop-target resolution and eligibility.
//
// These are the two places a pane drag can go quietly wrong: dropping onto a
// pane the user cannot see, and picking the wrong edge near a corner. Both are
// pure given a set of rects, so they are tested without a drag gesture.
import { describe, it, expect, beforeEach } from 'vitest';
import { collectDropRects, resolveDropTarget, type PaneRect } from '../paneDrag';

describe('resolveDropTarget', () => {
  const pane: PaneRect = { paneId: 'p1', left: 100, top: 100, width: 300, height: 200 };
  const rects = [pane];

  it('returns null when the pointer is outside every pane', () => {
    expect(resolveDropTarget(rects, 50, 50)).toBeNull();
    expect(resolveDropTarget(rects, 500, 150)).toBeNull();
  });

  it('resolves the centre to a swap', () => {
    const t = resolveDropTarget(rects, 250, 200); // dead centre
    expect(t).toEqual({ paneId: 'p1', edge: null });
  });

  it.each([
    ['left', 110, 200],
    ['right', 390, 200],
    ['top', 250, 110],
    ['bottom', 250, 290],
  ] as const)('resolves the %s band', (edge, x, y) => {
    expect(resolveDropTarget(rects, x, y)).toEqual({ paneId: 'p1', edge });
  });

  it('picks the proportionally nearest edge in a corner', () => {
    // Top-left corner, but much closer to the top edge in relative terms:
    // fx = 30/300 = 0.10, fy = 6/200 = 0.03 → top wins.
    expect(resolveDropTarget(rects, 130, 106)).toEqual({ paneId: 'p1', edge: 'top' });
    // Same corner, now relatively closer to the left: fx = 0.02, fy = 0.10.
    expect(resolveDropTarget(rects, 106, 120)).toEqual({ paneId: 'p1', edge: 'left' });
  });

  it('compares edges fairly across very different aspect ratios', () => {
    // A wide, short pane. 20px from the left is a 2% inset; 20px from the top
    // is 40%. An absolute-pixel comparison would wrongly call this "top".
    const wide: PaneRect = { paneId: 'w', left: 0, top: 0, width: 1000, height: 50 };
    expect(resolveDropTarget([wide], 20, 20)).toEqual({ paneId: 'w', edge: 'left' });
  });
});

describe('collectDropRects', () => {
  let root: HTMLElement;

  function addPane(id: string, opts: { ws?: string; zoomHidden?: boolean; size?: [number, number] } = {}) {
    const { ws = 'ws1', zoomHidden = false, size = [200, 100] } = opts;
    const host = document.createElement('div');
    if (zoomHidden) host.setAttribute('data-wmux-zoom-hidden', 'true');
    const el = document.createElement('div');
    el.setAttribute('data-pane-root', id);
    el.setAttribute('data-pane-workspace', ws);
    // jsdom has no layout, so getBoundingClientRect is stubbed per element.
    el.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: size[0], height: size[1] }) as DOMRect;
    host.appendChild(el);
    root.appendChild(host);
    return el;
  }

  beforeEach(() => {
    document.body.innerHTML = '';
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  it('excludes the pane being dragged', () => {
    addPane('a');
    addPane('b');
    const ids = collectDropRects({ root, sourcePaneId: 'a', workspaceId: 'ws1' }).map((r) => r.paneId);
    expect(ids).toEqual(['b']);
  });

  it('excludes panes in another workspace tile (multiview)', () => {
    addPane('mine');
    addPane('theirs', { ws: 'ws2' });
    const ids = collectDropRects({ root, sourcePaneId: 'src', workspaceId: 'ws1' }).map((r) => r.paneId);
    expect(ids).toEqual(['mine']);
  });

  it('excludes panes hidden behind a zoom', () => {
    addPane('visible');
    addPane('behindZoom', { zoomHidden: true });
    const ids = collectDropRects({ root, sourcePaneId: 'src', workspaceId: 'ws1' }).map((r) => r.paneId);
    expect(ids).toEqual(['visible']);
  });

  it('excludes zero-sized panes', () => {
    addPane('real');
    addPane('collapsed', { size: [0, 0] });
    const ids = collectDropRects({ root, sourcePaneId: 'src', workspaceId: 'ws1' }).map((r) => r.paneId);
    expect(ids).toEqual(['real']);
  });
});
