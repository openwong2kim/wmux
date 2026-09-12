import { describe, it, expect } from 'vitest';
import { initAtlasWakeRecovery, WAKE_RECOVER_THROTTLE_MS } from '../atlasWakeRecovery';

type Listener = () => void;

function makeFakeDocument(initial: DocumentVisibilityState = 'hidden') {
  const listeners = new Set<Listener>();
  return {
    visibilityState: initial,
    addEventListener: (_type: string, cb: EventListener) => { listeners.add(cb as Listener); },
    removeEventListener: (_type: string, cb: EventListener) => { listeners.delete(cb as Listener); },
    fire(): void {
      for (const cb of [...listeners]) cb();
    },
    show(): void {
      this.visibilityState = 'visible';
      this.fire();
    },
    hide(): void {
      this.visibilityState = 'hidden';
      this.fire();
    },
    listenerCount: () => listeners.size,
  };
}

function setup(nowStart = 0, initial: DocumentVisibilityState = 'hidden') {
  let now = nowStart;
  let resumeCb: Listener | null = null;
  let unsubscribed = 0;
  const recovered: string[] = [];
  const doc = makeFakeDocument(initial);
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
  it('recovers on resume, and again on the unlock that follows it (the latched backstop)', () => {
    const s = setup();
    // A real wake behind the lock screen: resume lands while hidden.
    s.fireResume();
    expect(s.recovered).toEqual(['system-resumed']);
    // Unlock. The latched rebuild is the effective one — Chromium can undo the
    // one above before first present — so it fires even inside the throttle.
    s.doc.show();
    expect(s.recovered).toEqual(['system-resumed', 'visibility']);
    // Next wake, past the throttle window → recovers again.
    s.advance(WAKE_RECOVER_THROTTLE_MS);
    s.fireResume();
    expect(s.recovered).toEqual(['system-resumed', 'visibility', 'system-resumed']);
  });

  it('holds the latch however long the unlock takes, then consumes it exactly once', () => {
    const s = setup();
    s.fireResume();
    s.advance(120_000); // a slow password entry: no time window could cover this
    s.doc.show();
    expect(s.recovered).toEqual(['system-resumed', 'visibility']);
    // One rebuild per resume: an alt-tab storm right after the wake adds none.
    for (let i = 0; i < 5; i++) {
      s.advance(WAKE_RECOVER_THROTTLE_MS * 5);
      s.doc.hide();
      s.doc.show();
    }
    expect(s.recovered).toEqual(['system-resumed', 'visibility']);
  });

  // #1234: on Windows, native occlusion flips visibilityState on every
  // alt-tab. An unarmed visibility change must not wipe the shared atlas.
  it('ignores unarmed visibility once a resume has been delivered (Windows alt-tab)', () => {
    const s = setup();
    s.fireResume();
    s.doc.show(); // consumes the latch
    const baseline = [...s.recovered];
    for (let i = 0; i < 10; i++) {
      s.advance(WAKE_RECOVER_THROTTLE_MS * 5);
      s.doc.hide();
      s.doc.show();
    }
    expect(s.recovered).toEqual(baseline);
  });

  it('does not arm the latch for a resume delivered while already visible', () => {
    const s = setup(0, 'visible');
    s.fireResume();
    expect(s.recovered).toEqual(['system-resumed']);
    // The visibilitychange that may follow ms later must not add a second wipe.
    s.doc.show();
    expect(s.recovered).toEqual(['system-resumed']);
  });

  // Electron's powerMonitor 'resume' exists everywhere but is not reliably
  // emitted on some Linux setups; gating on API presence would remove wake
  // recovery there forever, so the gate closes on first DELIVERY.
  it('keeps unconditional visibility recovery until a resume is ever delivered', () => {
    const s = setup();
    s.doc.show();
    expect(s.recovered).toEqual(['visibility']);
    s.advance(WAKE_RECOVER_THROTTLE_MS);
    s.doc.hide();
    s.doc.show();
    expect(s.recovered).toEqual(['visibility', 'visibility']);
    // First delivery proves the signal works — from here the latch is required.
    s.advance(WAKE_RECOVER_THROTTLE_MS);
    s.doc.hide(); // a real sleep: the resume lands on a hidden window
    s.fireResume();
    s.doc.show(); // consumes the latch armed by that resume
    s.advance(WAKE_RECOVER_THROTTLE_MS);
    s.doc.hide();
    s.doc.show();
    expect(s.recovered).toEqual([
      'visibility', 'visibility', 'system-resumed', 'visibility',
    ]);
  });

  it('teardown detaches both triggers', () => {
    const s = setup();
    s.teardown();
    expect(s.unsubscribes()).toBe(1);
    expect(s.doc.listenerCount()).toBe(0);
    s.doc.show();
    expect(s.recovered).toEqual([]);
  });
});
