import { describe, it, expect } from 'vitest';
import { initAtlasWakeRecovery, WAKE_RECOVER_THROTTLE_MS } from '../atlasWakeRecovery';

type Listener = () => void;

function makeFakeDocument(initial: DocumentVisibilityState = 'hidden') {
  const listeners = new Set<Listener>();
  return {
    visibilityState: initial,
    addEventListener: (_type: string, cb: EventListener) => { listeners.add(cb as Listener); },
    removeEventListener: (_type: string, cb: EventListener) => { listeners.delete(cb as Listener); },
    show(): void {
      this.visibilityState = 'visible';
      for (const cb of [...listeners]) cb();
    },
    listenerCount: () => listeners.size,
  };
}

function setup(nowStart = 0) {
  let now = nowStart;
  let resumeCb: Listener | null = null;
  let unsubscribed = 0;
  const recovered: string[] = [];
  const doc = makeFakeDocument();
  const teardown = initAtlasWakeRecovery({
    onSystemResumed: (cb) => {
      resumeCb = cb;
      return () => { unsubscribed++; };
    },
    recoverNow: (reason) => recovered.push(reason),
    documentRef: doc,
    now: () => now,
  });
  return {
    doc,
    recovered,
    teardown,
    fireResume: () => resumeCb?.(),
    unsubscribes: () => unsubscribed,
    advance: (ms: number) => { now += ms; },
  };
}

describe('atlasWakeRecovery', () => {
  it('rebuilds once when resume and visibility fire together (real wake), again after the throttle', () => {
    const s = setup();
    // A real wake: powerMonitor resume and visibilitychange land within ms.
    s.fireResume();
    s.doc.show();
    expect(s.recovered).toEqual(['system-resumed']); // second trigger throttled
    // Next wake, past the throttle window → recovers again.
    s.advance(WAKE_RECOVER_THROTTLE_MS);
    s.fireResume();
    expect(s.recovered).toEqual(['system-resumed', 'system-resumed']);
  });

  it('visibility trigger only fires on becoming visible; teardown detaches both triggers', () => {
    const s = setup();
    s.doc.visibilityState = 'hidden';
    s.doc.show();
    expect(s.recovered).toEqual(['visibility']);
    s.teardown();
    expect(s.unsubscribes()).toBe(1);
    s.advance(WAKE_RECOVER_THROTTLE_MS);
    s.doc.show();
    expect(s.recovered).toEqual(['visibility']); // detached — no further recovery
  });
});
