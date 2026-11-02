import { describe, it, expect } from 'vitest';
import { a2aPartyName } from '../paneNaming';
import type { PaneLeaf } from '../../../shared/types';

const leaf = (id: string, ordinal: number, ptyId: string): PaneLeaf => ({
  id,
  type: 'leaf',
  ordinal,
  activeSurfaceId: `s-${id}`,
  surfaces: [{ id: `s-${id}`, ptyId, title: '' } as PaneLeaf['surfaces'][number]],
});

const ws = {
  name: 'Simply',
  wsOrdinal: 2,
  rootPane: {
    id: 'root',
    type: 'branch' as const,
    direction: 'horizontal' as const,
    children: [leaf('a', 1, 'pty-a'), leaf('b', 2, 'pty-b')],
  },
  activePaneId: 'a',
};

describe('a2aPartyName', () => {
  it('joins the workspace and the pane the pty lives in with a dot', () => {
    expect(a2aPartyName(ws, { b: 'release' }, undefined, 'pty-b')).toBe('Simply.release');
  });

  it('uses the auto name when the pane was never renamed, with the agent suffix', () => {
    expect(a2aPartyName(ws, {}, { 'pty-a': { slug: 'claude' } }, 'pty-a')).toBe('Simply.w2-1(claude)');
  });

  it('falls back to the bare workspace name for an unknown or missing pty', () => {
    expect(a2aPartyName(ws, {}, undefined, 'pty-nope')).toBe('Simply');
    expect(a2aPartyName(ws, {}, undefined)).toBe('Simply');
  });
});
