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

function setup(
  nowStart = 0,
  initial: DocumentVisibilityState = 'hidden',
  platform = 'win32',
) {
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
    platform,
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

  // #1234's reporter logged 15 minutes of ordinary alt-tabbing with no reason
  // to think the machine had ever slept in that session. On the platform where
  // the fix is required, that must be zero atlas wipes -- a fix that waits for
  // a suspend to take effect is not a fix.
  it('recovers nothing across repeated visibility transitions with no resume ever delivered (win32)', () => {
    const s = setup(0, 'hidden', 'win32');
    for (let i = 0; i < 20; i++) {
      s.advance(30_000);
      s.doc.hide();
      s.advance(5_000);
      s.doc.show();
    }
    expect(s.recovered).toEqual([]);
  });

  it('requires the latch immediately on darwin too', () => {
    const s = setup(0, 'hidden', 'darwin');
    s.doc.show();
    expect(s.recovered).toEqual([]);
    // A real wake still recovers, latched.
    s.doc.hide();
    s.fireResume();
    s.doc.show();
    expect(s.recovered).toEqual(['system-resumed', 'visibility']);
  });

  // Electron's powerMonitor 'resume' exists everywhere but is not reliably
  // emitted on some Linux setups; gating on API presence would remove wake
  // recovery there forever, so on linux the gate closes on first DELIVERY.
  it('keeps unconditional visibility recovery on linux until a resume is ever delivered', () => {
    const s = setup(0, 'hidden', 'linux');
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

  it('treats an unknown platform like linux — recovery kept, not dropped', () => {
    const s = setup(0, 'hidden', 'freebsd');
    s.doc.show();
    expect(s.recovered).toEqual(['visibility']);
  });

  it('treats an absent platform (no preload bridge) the same way', () => {
    const recovered: string[] = [];
    const doc = makeFakeDocument();
    initAtlasWakeRecovery({
      onSystemResumed: () => () => { /* never delivers */ },
      platform: undefined,
      recoverNow: (reason) => recovered.push(reason),
      documentRef: doc,
      now: () => 0,
    });
    doc.show();
    expect(recovered).toEqual(['visibility']);
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
