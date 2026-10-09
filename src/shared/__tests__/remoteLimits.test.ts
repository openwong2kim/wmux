import { describe, expect, it } from 'vitest';
import { REMOTE_LIMITS, clampRemoteGeometry, parseRemoteLayout } from '../remoteLimits';

const leaf = (paneId: string, ptyId: string) => ({
  kind: 'leaf',
  paneId,
  surfaces: [{ surfaceId: `sf-${paneId}`, kind: 'terminal', ptyId }],
  activeIndex: 0,
});

function deepTree(depth: number): unknown {
  let node: unknown = leaf('p-bottom', 'pty-bottom');
  for (let i = 0; i < depth; i += 1) {
    node = { kind: 'split', direction: 'horizontal', sizes: [50, 50], children: [node, leaf(`p${i}`, `pty${i}`)] };
  }
  return node;
}

describe('parseRemoteLayout', () => {
  it('accepts a well-formed tree', () => {
    const layout = parseRemoteLayout({ root: deepTree(2), activePaneId: 'p0' });
    expect(layout?.root.kind).toBe('split');
    expect(layout?.activePaneId).toBe('p0');
  });

  it('refuses a tree deeper than the depth bound', () => {
    const drops: string[] = [];
    expect(parseRemoteLayout({ root: deepTree(REMOTE_LIMITS.layout.depth + 5) }, (r) => drops.push(r))).toBeUndefined();
    expect(drops).toEqual(['workspace.layout.depth']);
  });

  it('refuses a very deep tree without exhausting the stack', () => {
    expect(parseRemoteLayout({ root: deepTree(50_000) })).toBeUndefined();
  });

  it('refuses a tree with more leaves than the bound', () => {
    const children = Array.from({ length: REMOTE_LIMITS.layout.children }, (_, i) => ({
      kind: 'split',
      direction: 'vertical',
      sizes: [50, 50],
      children: [leaf(`a${i}`, `pa${i}`), leaf(`b${i}`, `pb${i}`)],
    }));
    const sizes = children.map(() => 1);
    expect(parseRemoteLayout({ root: { kind: 'split', direction: 'horizontal', sizes, children } })).toBeUndefined();
  });

  it('refuses duplicate pane or pty ids', () => {
    const dupPane = { kind: 'split', direction: 'horizontal', sizes: [50, 50], children: [leaf('p', 'x'), leaf('p', 'y')] };
    const dupPty = { kind: 'split', direction: 'horizontal', sizes: [50, 50], children: [leaf('p1', 'x'), leaf('p2', 'x')] };
    expect(parseRemoteLayout({ root: dupPane })).toBeUndefined();
    expect(parseRemoteLayout({ root: dupPty })).toBeUndefined();
  });

  it('refuses an over-long id', () => {
    expect(parseRemoteLayout({ root: leaf('p'.repeat(REMOTE_LIMITS.id + 1), 'x') })).toBeUndefined();
  });
});

describe('clampRemoteGeometry', () => {
  it('clamps into 1..geometryMax and floors', () => {
    expect(clampRemoteGeometry(1e9, -3)).toEqual({ cols: REMOTE_LIMITS.geometryMax, rows: 1 });
    expect(clampRemoteGeometry(80.9, 24)).toEqual({ cols: 80, rows: 24 });
  });

  it('refuses a value that is not a finite number', () => {
    expect(clampRemoteGeometry(Number.NaN, 24)).toBeNull();
    expect(clampRemoteGeometry(80, Number.POSITIVE_INFINITY)).toBeNull();
    expect(clampRemoteGeometry('80', 24)).toBeNull();
  });
});
