import { describe, expect, it, vi } from 'vitest';
import type { Pane, PaneLeaf, Surface } from '../types';
import {
  PRIVATE_BROWSER_PARTITION,
  createPrivateSessionWatcher,
  sessionLayoutWithoutPrivate,
  stashedPanesWithoutPrivate,
  stripPrivateBrowserSurfaces,
} from '../privateBrowser';

function terminal(id: string): Surface {
  return { id, ptyId: `pty-${id}`, title: 'Terminal', shell: 'zsh', cwd: '/', surfaceType: 'terminal' };
}

function browser(id: string, isPrivate = false): Surface {
  return {
    id, ptyId: '', title: 'Browser', shell: '', cwd: '', surfaceType: 'browser',
    browserUrl: `https://${id}.test/`,
    browserPartition: isPrivate ? PRIVATE_BROWSER_PARTITION : 'persist:wmux-default',
  };
}

function leaf(id: string, surfaces: Surface[], activeSurfaceId = surfaces[0]?.id ?? ''): PaneLeaf {
  return { id, type: 'leaf', surfaces, activeSurfaceId };
}

describe('session save excludes private browser surfaces', () => {
  it('drops a private tab from a mixed pane and moves the active tab off it', () => {
    const pane = leaf('p1', [terminal('t1'), browser('secret', true)], 'secret');

    const saved = stripPrivateBrowserSurfaces(pane) as PaneLeaf;

    expect(saved.surfaces.map((s) => s.id)).toEqual(['t1']);
    expect(saved.activeSurfaceId).toBe('t1');
    expect(pane.surfaces).toHaveLength(2); // the live tree is not mutated
  });

  it('removes a pane that held only private tabs and collapses its branch', () => {
    const root: Pane = {
      id: 'b1', type: 'branch', direction: 'horizontal', sizes: [30, 70],
      children: [leaf('p1', [terminal('t1')]), leaf('p2', [browser('secret', true)])],
    };

    const layout = sessionLayoutWithoutPrivate(root, 'p2');

    expect(layout.rootPane).toMatchObject({ id: 'p1', type: 'leaf' });
    expect(layout.activePaneId).toBe('p1');
  });

  it('re-shares sizes when a branch keeps more than one child', () => {
    const root: Pane = {
      id: 'b1', type: 'branch', direction: 'vertical', sizes: [20, 30, 50],
      children: [
        leaf('p1', [terminal('t1')]),
        leaf('p2', [browser('secret', true)]),
        leaf('p3', [browser('normal')]),
      ],
    };

    const saved = stripPrivateBrowserSurfaces(root);

    expect(saved?.type === 'branch' && saved.children.map((c) => c.id)).toEqual(['p1', 'p3']);
    expect(saved?.type === 'branch' && saved.sizes).toEqual([20 / 70 * 100, 50 / 70 * 100]);
  });

  it('keeps a workspace root when every pane was private, saved empty', () => {
    const layout = sessionLayoutWithoutPrivate(leaf('p1', [browser('secret', true)]), 'p1');

    expect(layout.rootPane).toMatchObject({ id: 'p1', type: 'leaf', surfaces: [] });
    expect(layout.activePaneId).toBe('p1');
  });

  it('strips private tabs from stashed panes and leaves out a private-only one', () => {
    const saved = stashedPanesWithoutPrivate([
      { pane: leaf('p1', [terminal('t1'), browser('secret', true)]), stashedAt: 1 },
      { pane: leaf('p2', [browser('secret2', true)]), stashedAt: 2 },
    ]);

    expect(saved.map((e) => [e.pane.id, e.pane.surfaces.map((s) => s.id)])).toEqual([['p1', ['t1']]]);
  });

  it('returns a tree with no private surface untouched', () => {
    const pane = leaf('p1', [terminal('t1'), browser('normal')]);
    expect(stripPrivateBrowserSurfaces(pane)).toBe(pane);
  });
});

describe('private session clear on last close', () => {
  const ws = (...surfaces: Surface[]) => ({ rootPane: leaf('p1', surfaces) });

  it('asks for a clear only when the last private tab closes', () => {
    const clear = vi.fn();
    const watch = createPrivateSessionWatcher(clear);

    watch([ws(terminal('t1'))]);
    watch([ws(terminal('t1'), browser('a', true), browser('b', true))]);
    watch([ws(terminal('t1'), browser('a', true))]); // one private tab left
    expect(clear).not.toHaveBeenCalled();

    watch([ws(terminal('t1'))]);
    expect(clear).toHaveBeenCalledTimes(1);

    watch([ws(terminal('t1'))]); // still none open: no repeat
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('counts a stashed private tab as still open', () => {
    const clear = vi.fn();
    const watch = createPrivateSessionWatcher(clear);

    watch([ws(browser('a', true))]);
    watch([{ rootPane: leaf('p1', [terminal('t1')]), stashedPanes: [{ pane: leaf('p2', [browser('a', true)]) }] }]);
    expect(clear).not.toHaveBeenCalled();
  });

  it('fires when the workspace holding the private tab goes away', () => {
    const clear = vi.fn();
    const watch = createPrivateSessionWatcher(clear);

    watch([ws(terminal('t1')), ws(browser('a', true))]);
    watch([ws(terminal('t1'))]);
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
