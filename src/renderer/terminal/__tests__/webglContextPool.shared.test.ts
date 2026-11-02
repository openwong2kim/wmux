import { describe, it, expect, vi } from 'vitest';
import { WebglContextPool } from '../webglContextPool';

/**
 * With the experimental shared WebGL context (uiSlice.terminalSharedWebgl), a
 * pane draws through one context every such pane shares and holds none of its
 * own. Its grant must not count against the context budget, wait for a slot,
 * or evict another terminal to the DOM renderer.
 */

function makeTerm(token: string) {
  return { token, acquire: vi.fn(() => undefined), dispose: vi.fn(() => undefined) };
}
type Term = ReturnType<typeof makeTerm>;

function request(pool: WebglContextPool, t: Term): void {
  pool.acquire(t.token, t.acquire, t.dispose);
}

describe('WebglContextPool with the shared WebGL context', () => {
  it('unbudgeted grants (shared WebGL context) take no slot, never evict and are never evicted', () => {
    const pool = new WebglContextPool(2);
    let shared = false;
    pool.setUnbudgeted(() => shared);
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(makeTerm);
    request(pool, a);
    request(pool, b); // budget full with own-context terminals

    shared = true;
    expect(pool.acquireWouldEvict('c')).toBe(false);
    request(pool, c);
    request(pool, d);
    expect(c.acquire).toHaveBeenCalledOnce();
    expect(d.acquire).toHaveBeenCalledOnce();
    expect(a.dispose).not.toHaveBeenCalled();
    expect(b.dispose).not.toHaveBeenCalled();
    expect(pool.grantedCount()).toBe(2);

    // An own-context grant made later evicts an own-context terminal, never a
    // shared one.
    shared = false;
    const e = makeTerm('e');
    request(pool, e);
    expect(a.dispose).toHaveBeenCalledOnce();
    expect(c.dispose).not.toHaveBeenCalled();
    expect(d.dispose).not.toHaveBeenCalled();
    expect(pool.grantedCount()).toBe(2);
    expect(pool.grantedTokens().sort()).toEqual(['b', 'c', 'd', 'e']);
  });

  it('with every pane on the shared context there is no budget: 40 panes all get WebGL', () => {
    const pool = new WebglContextPool();
    pool.setUnbudgeted(() => true);
    const terms = Array.from({ length: 40 }, (_, i) => makeTerm(`t${i}`));
    terms.forEach((t) => request(pool, t));
    terms.forEach((t) => expect(t.acquire).toHaveBeenCalledOnce());
    terms.forEach((t) => expect(t.dispose).not.toHaveBeenCalled());
    expect(pool.grantedCount()).toBe(0);
    expect(pool.grantedTokens()).toHaveLength(40);
  });

});
