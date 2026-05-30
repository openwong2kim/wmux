import { describe, it, expect, vi } from 'vitest';
import { WebglContextPool, MAX_WEBGL_CONTEXTS } from '../webglContextPool';

/**
 * The pool is pure LRU bookkeeping — every GPU side effect is a callback, so
 * we assert on acquire/dispose call order with spies. The invariant under test
 * is the one whose violation blanked terminals on session restore: the number
 * of simultaneously-granted contexts must NEVER exceed the budget.
 */

function makeTerm(token: string) {
  // `vi.fn(() => {})` infers a `() => void` mock so it satisfies the pool's
  // acquire/dispose callback types under strict tsc.
  return { token, acquire: vi.fn(() => {}), dispose: vi.fn(() => {}) };
}
type Term = ReturnType<typeof makeTerm>;

function request(pool: WebglContextPool, t: Term): void {
  pool.acquire(t.token, t.acquire, t.dispose);
}

describe('WebglContextPool', () => {
  it('grants a context to every terminal while under budget', () => {
    const pool = new WebglContextPool(4);
    const terms = ['a', 'b', 'c', 'd'].map(makeTerm);
    terms.forEach((t) => request(pool, t));

    terms.forEach((t) => expect(t.acquire).toHaveBeenCalledTimes(1));
    terms.forEach((t) => expect(t.dispose).not.toHaveBeenCalled());
    expect(pool.grantedCount()).toBe(4);
  });

  it('never exceeds the budget — evicts the LRU terminal on overflow', () => {
    const pool = new WebglContextPool(3);
    const a = makeTerm('a');
    const b = makeTerm('b');
    const c = makeTerm('c');
    const d = makeTerm('d');

    request(pool, a);
    request(pool, b);
    request(pool, c);
    expect(pool.grantedCount()).toBe(3);

    // 4th request overflows → 'a' (least recently requested) is evicted.
    request(pool, d);
    expect(pool.grantedCount()).toBe(3);
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(d.acquire).toHaveBeenCalledTimes(1);
    expect(pool.grantedTokens().sort()).toEqual(['b', 'c', 'd']);
  });

  it('treats a re-request as a use — bumps LRU so it is not the next victim', () => {
    const pool = new WebglContextPool(3);
    const a = makeTerm('a');
    const b = makeTerm('b');
    const c = makeTerm('c');
    const d = makeTerm('d');

    request(pool, a);
    request(pool, b);
    request(pool, c);
    // Touch 'a' again → it becomes most-recently-used; 'b' is now the LRU.
    request(pool, a);
    expect(a.acquire).toHaveBeenCalledTimes(1); // idempotent, no second GPU load

    request(pool, d); // overflow → evicts 'b', not 'a'
    expect(b.dispose).toHaveBeenCalledTimes(1);
    expect(a.dispose).not.toHaveBeenCalled();
    expect(pool.grantedTokens().sort()).toEqual(['a', 'c', 'd']);
  });

  it('frees a slot on release and lets a new terminal in', () => {
    const pool = new WebglContextPool(2);
    const a = makeTerm('a');
    const b = makeTerm('b');
    const c = makeTerm('c');

    request(pool, a);
    request(pool, b);
    expect(pool.grantedCount()).toBe(2);

    pool.release('a');
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(pool.grantedCount()).toBe(1);

    request(pool, c); // fits without evicting 'b'
    expect(b.dispose).not.toHaveBeenCalled();
    expect(pool.grantedTokens().sort()).toEqual(['b', 'c']);
  });

  it('re-grants after release using the latest callbacks (remount safety)', () => {
    const pool = new WebglContextPool(2);
    const a1 = makeTerm('a');
    request(pool, a1);
    pool.release('a');

    // Same token remounts with fresh closures.
    const a2 = makeTerm('a');
    request(pool, a2);
    expect(a2.acquire).toHaveBeenCalledTimes(1);
    expect(a1.acquire).toHaveBeenCalledTimes(1); // old closure untouched
  });

  it('notifyDisposed frees the slot but keeps the entry for re-grant', () => {
    const pool = new WebglContextPool(2);
    const a = makeTerm('a');
    const b = makeTerm('b');
    request(pool, a);
    request(pool, b);

    // Real GPU context loss on 'a' (addon already disposed itself).
    pool.notifyDisposed('a');
    expect(pool.grantedCount()).toBe(1);
    expect(a.dispose).not.toHaveBeenCalled(); // pool must NOT double-dispose

    // 'a' becomes visible again → re-granted with no eviction (slot was free).
    request(pool, a);
    expect(a.acquire).toHaveBeenCalledTimes(2);
    expect(b.dispose).not.toHaveBeenCalled();
    expect(pool.grantedCount()).toBe(2);
  });

  it('holds the line at exactly the budget across a 20-session restore burst', () => {
    // Reproduces the dogfood scenario: 20 terminals all request a context in a
    // startup burst. Pre-fix this blew past Chromium's cap and blanked panes.
    const pool = new WebglContextPool(MAX_WEBGL_CONTEXTS);
    const terms = Array.from({ length: 20 }, (_, i) => makeTerm(`s${i}`));
    terms.forEach((t) => request(pool, t));

    expect(pool.grantedCount()).toBe(MAX_WEBGL_CONTEXTS);
    // The 12 most-recently-requested keep GPU; the first 8 fell back to DOM.
    const granted = pool.grantedTokens().sort((x, y) => Number(x.slice(1)) - Number(y.slice(1)));
    expect(granted).toEqual(
      Array.from({ length: MAX_WEBGL_CONTEXTS }, (_, i) => `s${i + (20 - MAX_WEBGL_CONTEXTS)}`),
    );
    // Every over-budget terminal got a controlled dispose (→ DOM), never a
    // Chromium force-evict.
    const evicted = terms.slice(0, 20 - MAX_WEBGL_CONTEXTS);
    evicted.forEach((t) => expect(t.dispose).toHaveBeenCalledTimes(1));
  });

  it('clamps a non-positive budget to 1 so the focused terminal always has GPU', () => {
    const pool = new WebglContextPool(0);
    const a = makeTerm('a');
    const b = makeTerm('b');
    request(pool, a);
    request(pool, b);
    expect(pool.grantedCount()).toBe(1);
    expect(pool.grantedTokens()).toEqual(['b']); // most recent wins
  });
});
