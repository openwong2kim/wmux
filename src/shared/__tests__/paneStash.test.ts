import { describe, it, expect } from 'vitest';
import {
  canStashPaneSurfaces,
  stashedPaneLiveness,
  findStashedEntry,
  paneStashedError,
  PANE_STASHED,
  STASHABLE_SURFACE_TYPES,
} from '../paneStash';
import type { PaneLeaf, StashedPane, Surface } from '../types';

function surface(id: string, ptyId: string, surfaceType?: Surface['surfaceType']): Surface {
  return { id, ptyId, title: id, shell: 'pwsh', cwd: 'C:\\repo', ...(surfaceType ? { surfaceType } : {}) };
}

function leaf(id: string, surfaces: Surface[]): PaneLeaf {
  return { id, type: 'leaf', surfaces, activeSurfaceId: surfaces[0]?.id ?? '' };
}

describe('canStashPaneSurfaces', () => {
  it('allows terminals — including the legacy undefined surfaceType', () => {
    expect(canStashPaneSurfaces(leaf('p', [surface('a', 'pty-a')]))).toEqual({ ok: true });
    expect(canStashPaneSurfaces(leaf('p', [surface('a', 'pty-a', 'terminal')]))).toEqual({ ok: true });
  });

  it('allows browsers — cold-park already unmounts webviews and restores them by URL', () => {
    expect(canStashPaneSurfaces(leaf('p', [surface('a', '', 'browser')]))).toEqual({ ok: true });
  });

  it.each(['editor', 'diff', 'git', 'review'] as const)(
    'refuses a %s surface and names the type',
    (surfaceType) => {
      // The daemon ring preserves PTY bytes and nothing else, so unmounting one
      // of these drops unsaved work with no way to replay it.
      expect(canStashPaneSurfaces(leaf('p', [surface('a', '', surfaceType)])))
        .toEqual({ ok: false, reason: 'surface', surfaceType });
    },
  );

  it('refuses a mixed pane — one unstashable tab is enough', () => {
    const mixed = leaf('p', [surface('a', 'pty-a'), surface('b', '', 'editor')]);
    expect(canStashPaneSurfaces(mixed)).toMatchObject({ ok: false, surfaceType: 'editor' });
  });

  it('keeps the allow-list to the two types the ring can actually restore', () => {
    expect([...STASHABLE_SURFACE_TYPES].sort()).toEqual(['browser', 'terminal']);
  });
});

describe('stashedPaneLiveness', () => {
  it('is alive while ANY terminal surface holds a pty', () => {
    // The same rule a visible multi-tab pane follows.
    expect(stashedPaneLiveness(leaf('p', [surface('a', ''), surface('b', 'pty-b')]))).toBe('alive');
  });

  it('is exited only when every terminal surface has lost its pty', () => {
    expect(stashedPaneLiveness(leaf('p', [surface('a', ''), surface('b', '')]))).toBe('exited');
  });

  it('ignores non-terminal surfaces when deciding', () => {
    const browserOnly = leaf('p', [surface('a', '', 'browser')]);
    // No session to lose. Calling it exited would offer a shell recovery for a
    // pane that never had a shell.
    expect(stashedPaneLiveness(browserOnly)).toBe('alive');

    const deadTerminalPlusBrowser = leaf('p', [surface('a', ''), surface('b', '', 'browser')]);
    expect(stashedPaneLiveness(deadTerminalPlusBrowser)).toBe('exited');
  });

  it('treats a surfaceless pane as alive rather than inventing a death', () => {
    expect(stashedPaneLiveness(leaf('p', []))).toBe('alive');
  });
});

describe('findStashedEntry', () => {
  const entry: StashedPane = { pane: leaf('p2', [surface('a', 'pty-a')]), stashedAt: 1 };

  it('finds by pane id', () => {
    expect(findStashedEntry([entry], 'p2')).toBe(entry);
  });

  it('is safe on undefined, empty, and malformed input', () => {
    expect(findStashedEntry(undefined, 'p2')).toBeUndefined();
    expect(findStashedEntry([], 'p2')).toBeUndefined();
    expect(findStashedEntry([null as unknown as StashedPane, entry], 'nope')).toBeUndefined();
  });
});

describe('paneStashedError', () => {
  const err = paneStashedError('pane.focus', 'pane-42');

  it('carries a machine-readable code and an invocable recovery', () => {
    // An agent must be able to ACT on the refusal without parsing prose.
    expect(err.code).toBe(PANE_STASHED);
    expect(err.recovery).toEqual({ method: 'pane.unstash', params: { id: 'pane-42' } });
  });

  it('is English, method-prefixed, and says what still works', () => {
    // RPC errors never pass through i18n — the reader is an agent, and an agent
    // has no locale.
    expect(err.error.startsWith('pane.focus: ')).toBe(true);
    expect(err.error).toContain('pane-42');
    expect(err.error).toContain('pane.unstash');
    // The remedy is not the only option: reading and writing work in place, and
    // an agent told only to "unstash" would rearrange a layout it never needed
    // to touch.
    expect(err.error).toContain('input.readScreen');
    expect(err.error).toContain('input.send');
  });
});
