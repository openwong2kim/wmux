import { describe, it, expect } from 'vitest';

import {
  DESKTOP_PRESENCE_STALE_AFTER_MS,
  DesktopPresenceTracker,
  emptyDesktopPresence,
  isDesktopPresent,
  shouldSuppressPush,
  type DesktopPresenceState,
  type PushPresenceSuppressionConfig,
} from '../presence';
import { PUSH_RISK_CRITICAL, PUSH_RISK_NORMAL } from '../../../shared/push/pushEnvelope';

const NOW = 1753420800000;

const ON: PushPresenceSuppressionConfig = {
  enabled: true,
  staleAfterMs: DESKTOP_PRESENCE_STALE_AFTER_MS,
};

function present(overrides: Partial<DesktopPresenceState> = {}): DesktopPresenceState {
  return { connected: true, focused: true, reportedAt: NOW, ...overrides };
}

describe('isDesktopPresent', () => {
  it('is present for a connected client that reported focus just now', () => {
    expect(isDesktopPresent(present(), NOW)).toBe(true);
  });

  it('is present up to the freshness bound and absent one ms past it', () => {
    const at = present({ reportedAt: NOW - DESKTOP_PRESENCE_STALE_AFTER_MS });
    expect(isDesktopPresent(at, NOW)).toBe(true);
    expect(isDesktopPresent(present({ reportedAt: NOW - DESKTOP_PRESENCE_STALE_AFTER_MS - 1 }), NOW))
      .toBe(false);
  });

  it('is absent when never reported, blurred, disconnected, or future-dated', () => {
    expect(isDesktopPresent(emptyDesktopPresence(), NOW)).toBe(false);
    expect(isDesktopPresent(present({ focused: false }), NOW)).toBe(false);
    expect(isDesktopPresent(present({ connected: false }), NOW)).toBe(false);
    expect(isDesktopPresent(present({ reportedAt: NOW + 5_000 }), NOW)).toBe(false);
  });

  it('is absent when the freshness window is non-positive or not a number', () => {
    expect(isDesktopPresent(present(), NOW, 0)).toBe(false);
    expect(isDesktopPresent(present(), NOW, Number.NaN)).toBe(false);
  });
});

describe('shouldSuppressPush', () => {
  it('suppresses a normal-risk push while the desktop is freshly focused', () => {
    expect(
      shouldSuppressPush({ state: present(), now: NOW, config: ON, risk: PUSH_RISK_NORMAL }),
    ).toBe(true);
  });

  it('sends when the presence report has gone stale', () => {
    const stale = present({ reportedAt: NOW - DESKTOP_PRESENCE_STALE_AFTER_MS - 1 });
    expect(
      shouldSuppressPush({ state: stale, now: NOW, config: ON, risk: PUSH_RISK_NORMAL }),
    ).toBe(false);
  });

  it('sends a critical-risk push even when the desktop is present', () => {
    expect(
      shouldSuppressPush({ state: present(), now: NOW, config: ON, risk: PUSH_RISK_CRITICAL }),
    ).toBe(false);
  });

  it('sends when suppression is disabled by config', () => {
    expect(
      shouldSuppressPush({
        state: present(),
        now: NOW,
        config: { ...ON, enabled: false },
        risk: PUSH_RISK_NORMAL,
      }),
    ).toBe(false);
  });

  it('sends when the daemon has never heard from a desktop (headless)', () => {
    expect(
      shouldSuppressPush({ state: emptyDesktopPresence(), now: NOW, config: ON }),
    ).toBe(false);
  });
});

describe('DesktopPresenceTracker', () => {
  it('records a focus report and retracts it on that client disconnecting', () => {
    const tracker = new DesktopPresenceTracker();
    expect(isDesktopPresent(tracker.snapshot(), NOW)).toBe(false);

    tracker.report('c1', true, NOW);
    expect(isDesktopPresent(tracker.snapshot(), NOW)).toBe(true);

    tracker.forget('c1');
    expect(isDesktopPresent(tracker.snapshot(), NOW)).toBe(false);
  });

  it('ignores a disconnect from a client that no longer owns the report', () => {
    const tracker = new DesktopPresenceTracker();
    tracker.report('c1', true, NOW);
    // c1 was replaced by c2 (reconnect) — c1's late close must not blank it.
    tracker.report('c2', true, NOW);
    tracker.forget('c1');
    expect(isDesktopPresent(tracker.snapshot(), NOW)).toBe(true);
  });

  it('treats a blur report as absent immediately', () => {
    const tracker = new DesktopPresenceTracker();
    tracker.report('c1', true, NOW);
    tracker.report('c1', false, NOW);
    expect(isDesktopPresent(tracker.snapshot(), NOW)).toBe(false);
  });
});
