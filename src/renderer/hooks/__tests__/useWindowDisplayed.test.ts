import { describe, it, expect, vi } from 'vitest';
import { createWindowDisplayedStore } from '../useWindowDisplayed';

/** A controllable stand-in for the preload bridge. */
function fakeBridge(initial: boolean, opts: { rejects?: boolean } = {}) {
  let resolvePull: (v: boolean) => void = () => {};
  let rejectPull: (e: unknown) => void = () => {};
  const pull = new Promise<boolean>((res, rej) => { resolvePull = res; rejectPull = rej; });
  const pushListeners = new Set<(v: boolean) => void>();
  return {
    deps: {
      isDisplayed: () => pull,
      onDisplayedChanged: (cb: (v: boolean) => void) => {
        pushListeners.add(cb);
        return () => { pushListeners.delete(cb); };
      },
    },
    settlePull: async () => {
      if (opts.rejects) rejectPull(new Error('no such handler'));
      else resolvePull(initial);
      await Promise.resolve();
      await Promise.resolve();
    },
    push: (v: boolean) => { for (const cb of [...pushListeners]) cb(v); },
    listenerCount: () => pushListeners.size,
  };
}

describe('windowDisplayedStore', () => {
  it('defaults to true before main has answered', () => {
    // Same optimistic default the daemon holds (viewerVisible: true), so a
    // preload too old to expose the bridge behaves exactly as before.
    const store = createWindowDisplayedStore();
    expect(store.get()).toBe(true);
  });

  it('takes the pulled value at init — the case a push-only design misses', async () => {
    // The window can already be hidden when the renderer loads: started to
    // tray, or reloaded after a renderer crash.
    const store = createWindowDisplayedStore();
    const bridge = fakeBridge(false);
    store.init(bridge.deps);
    await bridge.settlePull();
    expect(store.get()).toBe(false);
  });

  it('follows pushes and notifies subscribers on change only', async () => {
    const store = createWindowDisplayedStore();
    const bridge = fakeBridge(true);
    store.init(bridge.deps);
    await bridge.settlePull();

    const listener = vi.fn();
    store.subscribe(listener);

    bridge.push(false);
    expect(store.get()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    bridge.push(false); // no change
    expect(listener).toHaveBeenCalledTimes(1);

    bridge.push(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('a push that lands before the pull resolves is not overwritten by it', async () => {
    // The invoke is in flight while the user minimizes: the pull's answer is
    // already stale by the time it arrives.
    const store = createWindowDisplayedStore();
    const bridge = fakeBridge(true); // pull will answer "displayed"
    store.init(bridge.deps);

    bridge.push(false);
    expect(store.get()).toBe(false);

    await bridge.settlePull();
    expect(store.get()).toBe(false);
  });

  it('a failed pull leaves the safe default and the push path still works', async () => {
    const store = createWindowDisplayedStore();
    const bridge = fakeBridge(false, { rejects: true });
    store.init(bridge.deps);
    await bridge.settlePull();
    expect(store.get()).toBe(true);

    bridge.push(false);
    expect(store.get()).toBe(false);
  });

  it('unsubscribe stops delivery; teardown detaches the bridge and ignores late answers', async () => {
    const store = createWindowDisplayedStore();
    const bridge = fakeBridge(false);
    const teardown = store.init(bridge.deps);

    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    bridge.push(false);
    expect(listener).not.toHaveBeenCalled();

    teardown();
    expect(bridge.listenerCount()).toBe(0);
    // A pull that resolves after teardown must not mutate a torn-down store.
    const before = store.get();
    await bridge.settlePull();
    expect(store.get()).toBe(before);
  });

  it('init without a bridge (old preload) does not throw and keeps the default', () => {
    const store = createWindowDisplayedStore();
    const teardown = store.init({});
    expect(store.get()).toBe(true);
    expect(() => teardown()).not.toThrow();
  });
});
