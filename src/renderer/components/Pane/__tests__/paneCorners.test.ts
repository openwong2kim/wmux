// Which pane gets which corner of the workspace column, walked the way
// PaneContainer does: left corners (sidebar on the left) and right corners
// (sidebar on the right) both follow the shown panes, zoom included. And which
// column sides glass may stop clipping: both corner panes plain terminals.
import { describe, expect, it } from 'vitest';
import type { Pane, PaneLeaf } from '../../../../shared/types';
import { findLeaf } from '../../../../shared/paneUtils';
import { ALL_PANE_CORNERS, childCorners, glassCornerSides } from '../paneCorners';

const leaf = (id: string): Pane => ({ id, type: 'leaf', surfaces: [], activeSurfaceId: '' });
const split = (direction: 'horizontal' | 'vertical', ...children: Pane[]): Pane => ({ id: children.map((c) => c.id).join('+'), type: 'branch', direction, children });

function corners(root: Pane, zoomed: string | null = null): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (pane: Pane, c: string) => {
    if (pane.type === 'leaf') { out[pane.id] = c; return; }
    const zoomIn = zoomed !== null && findLeaf(pane, zoomed) !== null;
    const shown = pane.children.map((child) => zoomed === null || !zoomIn || findLeaf(child, zoomed) !== null);
    pane.children.forEach((child, i) => walk(child, childCorners(c, pane.direction, i, shown)));
  };
  walk(root, ALL_PANE_CORNERS);
  return out;
}

describe('pane corners', () => {
  it('gives the left corners to the first column and the right ones to the last, top and bottom by row', () => {
    const tree = split('horizontal', split('vertical', leaf('a'), leaf('b'), leaf('c')), split('vertical', leaf('d'), split('horizontal', leaf('e'), leaf('f'))));
    expect(corners(tree)).toEqual({ a: 'tl', b: '', c: 'bl', d: 'tr', e: '', f: 'br' });
  });

  it('follows a zoomed pane, which takes every corner', () => {
    const tree = split('horizontal', split('vertical', leaf('a'), leaf('b')), leaf('c'));
    expect(corners(tree, 'b')).toEqual({ a: '', b: ALL_PANE_CORNERS, c: '' });
    expect(corners(leaf('only'))).toEqual({ only: ALL_PANE_CORNERS });
  });

  it('opens a side only when both of its corner panes show a plain terminal', () => {
    const term = (id: string, viewMode?: 'chat'): Pane => ({ id, type: 'leaf', activeSurfaceId: `${id}-s`, surfaces: [{ id: `${id}-s`, surfaceType: 'terminal', viewMode }] } as unknown as PaneLeaf);
    const withBrowser = (id: string): Pane => ({ id, type: 'leaf', activeSurfaceId: `${id}-s`, surfaces: [{ id: `${id}-s`, surfaceType: 'terminal' }, { id: `${id}-b`, surfaceType: 'browser' }] } as unknown as PaneLeaf);
    const tree = (b: Pane) => split('horizontal', split('vertical', term('a'), b), term('c'));
    expect(glassCornerSides(tree(term('b')), null, false)).toBe('left right');
    expect(glassCornerSides(tree(withBrowser('b')), null, false)).toBe('right');
    expect(glassCornerSides(tree(term('b', 'chat')), null, true)).toBe('right');
    expect(glassCornerSides(tree(term('b', 'chat')), null, false)).toBe('left right');
    expect(glassCornerSides(tree(withBrowser('b')), 'c', false)).toBe('left right');
    expect(glassCornerSides(tree(withBrowser('b')), 'b', false)).toBe('');
  });
});
