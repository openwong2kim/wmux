import { describe, expect, it } from 'vitest';
import { REMOTE_LIMITS, boundedRemoteString, cleanRemoteText, clampRemoteGeometry, parseRemoteLayout, remoteId } from '../remoteLimits';

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

describe('remote text', () => {
  const ch = (...codes: number[]) => String.fromCharCode(...codes);

  it('replaces each run of C0, C1, DEL, separator and bidi controls with one space', () => {
    expect(cleanRemoteText(`a${ch(0x1b, 0x5b)}b`, 100)).toBe('a [b');
    expect(cleanRemoteText(`a${ch(0x0d, 0x0a, 0x00, 0x7f, 0x85)}b`, 100)).toBe('a b');
    expect(cleanRemoteText(`a${ch(0x2028)}b${ch(0x2029)}c`, 100)).toBe('a b c');
    for (const code of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
      expect(cleanRemoteText(`a${ch(code)}b`, 100)).toBe('a b');
    }
  });

  it('keeps ordinary text, including non-Latin scripts and emoji joiners', () => {
    const text = `한글 مرحبا ${ch(0xd83d, 0xdc69, 0x200d, 0xd83d, 0xdcbb)} C:\\work`;
    expect(cleanRemoteText(text, 100)).toBe(text);
  });

  it('cuts before cleaning, so the result is never longer than the limit', () => {
    expect(cleanRemoteText('x'.repeat(10) + ch(0x1b), 10)).toBe('x'.repeat(10));
    expect(boundedRemoteString(`${ch(0x1b)}abc`, 2)).toBe(' a');
    expect(boundedRemoteString(42, 2)).toBeUndefined();
  });

  it('refuses an id that carries a control character instead of rewriting it', () => {
    expect(remoteId('session-1')).toBe('session-1');
    expect(remoteId(`session${ch(0x0a)}1`)).toBeUndefined();
    expect(remoteId(`session${ch(0x202e)}1`)).toBeUndefined();
  });
});

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
