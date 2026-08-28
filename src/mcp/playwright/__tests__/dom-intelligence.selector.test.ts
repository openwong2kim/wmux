// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildDomSnapshotExpression } from '../dom-intelligence';

// Selector-scoped DOM snapshot (Phase 1): the expression runs against jsdom
// (document/location are globals there), the same way the markdown-extractor
// dom tests execute in-page code.

function run(expr: string): string {
  // Indirect eval → runs in global scope where jsdom's document lives.
  return (0, eval)(expr) as string;
}

describe('buildDomSnapshotExpression(rootSelector)', () => {
  it('tags and lists only interactive elements under the scope root', () => {
    document.body.innerHTML =
      '<main><h2>Inside</h2><button id="b1">In</button></main>' +
      '<h2>Outside</h2><button id="b2">Out</button>';

    const out = run(buildDomSnapshotExpression('main'));

    expect(out).toContain('Scope: main');
    expect(out).toContain('"In"');
    expect(out).not.toContain('"Out"');
    expect(out).toContain('H2: Inside');
    expect(out).not.toContain('H2: Outside');
    expect(document.getElementById('b1')?.getAttribute('data-wmux-ref')).toBe('0');
    expect(document.getElementById('b2')?.hasAttribute('data-wmux-ref')).toBe(false);
  });

  it('wipes stale refs document-wide even when they fall outside the scope', () => {
    document.body.innerHTML =
      '<main><button id="b1">In</button></main><button id="b2" data-wmux-ref="7">Out</button>';

    run(buildDomSnapshotExpression('main'));

    // The out-of-scope stale ref must not survive to collide with fresh 0-based numbering.
    expect(document.getElementById('b2')?.hasAttribute('data-wmux-ref')).toBe(false);
  });

  it('reports a non-matching selector instead of throwing', () => {
    document.body.innerHTML = '<button>x</button>';
    const out = run(buildDomSnapshotExpression('#nope'));
    expect(out).toBe('No element matches selector: #nope');
  });
});
