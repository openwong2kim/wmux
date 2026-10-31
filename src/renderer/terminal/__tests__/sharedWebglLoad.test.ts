import { describe, expect, it, vi } from 'vitest';
import { loadedSharedWebglAddon, preloadSharedWebgl } from '../sharedWebgl/load';
import { WebglContextPool } from '../webglContextPool';

/**
 * The shared-context WebGL fork is a lazily loaded chunk. Until it has loaded,
 * a pane must get the stock addon through the context pool exactly as with
 * the flag off: a budgeted grant, built by the stock constructor. The tests
 * run in order; the module state is this file's own.
 */
describe('sharedWebgl lazy load', () => {
  // useTerminal's decision, with the flag on: the fork's class if loaded,
  // else null (stock addon), and the pool budgets exactly the stock grants.
  const pool = new WebglContextPool(1);
  pool.setUnbudgeted(() => loadedSharedWebglAddon() !== null);
  const term = (token: string) => ({ token, acquire: vi.fn(() => undefined), dispose: vi.fn(() => undefined) });

  it('takes the stock path before the chunk is loaded, including a budgeted pool grant', () => {
    expect(loadedSharedWebglAddon()).toBeNull();
    const [a, b] = [term('a'), term('b')];
    pool.acquire(a.token, a.acquire, a.dispose);
    expect(pool.acquireWouldEvict('b')).toBe(true);
    pool.acquire(b.token, b.acquire, b.dispose);
    expect(a.dispose).toHaveBeenCalledOnce(); // budget 1: the stock path still evicts
    expect(pool.grantedCount()).toBe(1);
  });

  it('starts loading once, and the class is only there after the chunk resolves', async () => {
    const first = preloadSharedWebgl();
    expect(preloadSharedWebgl()).toBe(first);
    expect(loadedSharedWebglAddon()).toBeNull();
    const cls = await first;
    expect(cls).not.toBeNull();
    expect(loadedSharedWebglAddon()).toBe(cls);
    expect(new cls!({ sharedContext: true }).usesSharedContext).toBe(true);
  });

  it('after loading, new grants are unbudgeted and the earlier stock grant is left alone', () => {
    const c = term('c');
    expect(pool.acquireWouldEvict('c')).toBe(false);
    pool.acquire(c.token, c.acquire, c.dispose);
    expect(c.acquire).toHaveBeenCalledOnce();
    expect(pool.grantedTokens()).toEqual(['b', 'c']);
    expect(pool.grantedCount()).toBe(1);
  });
});
