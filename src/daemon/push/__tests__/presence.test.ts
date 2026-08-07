import { describe, it, expect, vi } from 'vitest';

import {
  DEFERRED_PUSH_CAP,
  DESKTOP_PRESENCE_STALE_AFTER_MS,
  DESKTOP_PRESENCE_STALE_CAP_MS,
  DeferredPushQueue,
  DesktopPresenceTracker,
  createPresenceRpcHandler,
  emptyDesktopPresence,
  failOpenPresenceConfig,
  isDesktopPresent,
  shouldSuppressPush,
  type DesktopPresenceState,
  type PushPresenceSuppressionConfig,
} from '../presence';
import { PUSH_RISK_CRITICAL, PUSH_RISK_NORMAL, type PushPayload } from '../../../shared/push/pushEnvelope';

const NOW = 1753420800000;

const ON: PushPresenceSuppressionConfig = {
  enabled: true,
  staleAfterMs: DESKTOP_PRESENCE_STALE_AFTER_MS,
};

function present(overrides: { focused?: boolean; reportedAt?: number } = {}): DesktopPresenceState {
  return { clients: [{ focused: true, reportedAt: NOW, ...overrides }] };
}

describe('isDesktopPresent', () => {
  it('is present for a client that reported focus just now', () => {
    expect(isDesktopPresent(present(), NOW)).toBe(true);
  });

  it('is present up to the freshness bound and absent one ms past it', () => {
    expect(isDesktopPresent(present({ reportedAt: NOW - DESKTOP_PRESENCE_STALE_AFTER_MS }), NOW))
      .toBe(true);
    expect(isDesktopPresent(present({ reportedAt: NOW - DESKTOP_PRESENCE_STALE_AFTER_MS - 1 }), NOW))
      .toBe(false);
  });

  it('is absent when never reported, blurred, or future-dated', () => {
    expect(isDesktopPresent(emptyDesktopPresence(), NOW)).toBe(false);
    expect(isDesktopPresent(present({ focused: false }), NOW)).toBe(false);
    expect(isDesktopPresent(present({ reportedAt: NOW + 5_000 }), NOW)).toBe(false);
  });

  it('is absent when the freshness window is non-positive or not a number', () => {
    expect(isDesktopPresent(present(), NOW, 0)).toBe(false);
    expect(isDesktopPresent(present(), NOW, Number.NaN)).toBe(false);
  });

  it('clamps an oversized freshness window rather than honouring it', () => {
    const ancient = present({ reportedAt: NOW - DESKTOP_PRESENCE_STALE_CAP_MS - 1 });
    // A day-long window would otherwise make this report "fresh" forever.
    expect(isDesktopPresent(ancient, NOW, 24 * 60 * 60_000)).toBe(false);
  });

  it('is present when ANY client is freshly focused', () => {
    const state: DesktopPresenceState = {
      clients: [
        { focused: false, reportedAt: NOW },
        { focused: true, reportedAt: NOW },
      ],
    };
    expect(isDesktopPresent(state, NOW)).toBe(true);
  });
});

describe('shouldSuppressPush', () => {
  it('holds a normal-risk push while the desktop is freshly focused', () => {
    expect(shouldSuppressPush({ state: present(), now: NOW, config: ON, risk: PUSH_RISK_NORMAL }))
      .toBe(true);
  });

  it('sends when the presence report has gone stale', () => {
    const stale = present({ reportedAt: NOW - DESKTOP_PRESENCE_STALE_AFTER_MS - 1 });
    expect(shouldSuppressPush({ state: stale, now: NOW, config: ON, risk: PUSH_RISK_NORMAL }))
      .toBe(false);
  });

  it('sends a critical-risk push even when the desktop is present', () => {
    expect(shouldSuppressPush({ state: present(), now: NOW, config: ON, risk: PUSH_RISK_CRITICAL }))
      .toBe(false);
  });

  it('sends when suppression is disabled by config', () => {
    expect(
      shouldSuppressPush({ state: present(), now: NOW, config: { ...ON, enabled: false } }),
    ).toBe(false);
  });

  it('sends on the fail-open config, which is what every error path uses', () => {
    expect(
      shouldSuppressPush({ state: present(), now: NOW, config: failOpenPresenceConfig() }),
    ).toBe(false);
  });

  it('sends when the daemon has never heard from a desktop (headless)', () => {
    expect(shouldSuppressPush({ state: emptyDesktopPresence(), now: NOW, config: ON })).toBe(false);
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

  it('does not let a second client flip a real blur back to present', () => {
    const tracker = new DesktopPresenceTracker();
    tracker.report('c1', true, NOW);
    tracker.report('c1', false, NOW);
    // A second client reporting focus is its OWN slot; it does not overwrite
    // c1's blur, but it is genuinely a focused window, so presence holds.
    tracker.report('c2', true, NOW);
    expect(isDesktopPresent(tracker.snapshot(), NOW)).toBe(true);
    // ...and when that second client blurs, nothing is left claiming presence.
    tracker.report('c2', false, NOW);
    expect(isDesktopPresent(tracker.snapshot(), NOW)).toBe(false);
  });

  it('removes only the disconnecting client entry', () => {
    const tracker = new DesktopPresenceTracker();
    tracker.report('c1', true, NOW);
    tracker.report('c2', true, NOW);
    tracker.forget('c1');
    // c2 is still focused and still counts.
    expect(isDesktopPresent(tracker.snapshot(), NOW)).toBe(true);
    tracker.forget('c2');
    expect(isDesktopPresent(tracker.snapshot(), NOW)).toBe(false);
  });

  it('starts empty, so a reconnecting daemon has no inherited presence', () => {
    const tracker = new DesktopPresenceTracker();
    expect(tracker.snapshot().clients).toHaveLength(0);
    // A new connection is a new client id; the old one is gone with its socket.
    tracker.report('c1', true, NOW);
    tracker.forget('c1');
    tracker.report('c2', false, NOW);
    expect(isDesktopPresent(tracker.snapshot(), NOW)).toBe(false);
  });

  it('treats a blur report as absent immediately', () => {
    const tracker = new DesktopPresenceTracker();
    tracker.report('c1', true, NOW);
    tracker.report('c1', false, NOW);
    expect(isDesktopPresent(tracker.snapshot(), NOW)).toBe(false);
  });
});

describe('createPresenceRpcHandler', () => {
  function handler(isFirstParty: (id: string) => boolean) {
    const tracker = new DesktopPresenceTracker();
    const onPresenceChanged = vi.fn();
    const log = vi.fn();
    const rpc = createPresenceRpcHandler({
      isFirstParty,
      tracker,
      onPresenceChanged,
      now: () => NOW,
      log,
    });
    return { rpc, tracker, onPresenceChanged, log };
  }

  it('records a report from the first-party client', () => {
    const h = handler(() => true);
    expect(h.rpc({ focused: true }, 'c1')).toEqual({ ok: true });
    expect(isDesktopPresent(h.tracker.snapshot(), NOW)).toBe(true);
    expect(h.onPresenceChanged).toHaveBeenCalled();
  });

  it('ignores a spoofed report from a non-first-party client and warns once', () => {
    const h = handler(() => false);
    // What an MCP client or a prompt-injected agent would try: claim focus so
    // its own gated tool calls never reach the phone.
    expect(h.rpc({ focused: true }, 'mcp-7')).toEqual({ ok: false, reason: 'not-authorized' });
    expect(isDesktopPresent(h.tracker.snapshot(), NOW)).toBe(false);
    expect(h.tracker.snapshot().clients).toHaveLength(0);
    expect(h.onPresenceChanged).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledTimes(1);
    expect(h.log.mock.calls[0]?.[0]).toBe('warn');
  });

  it('reads a missing or non-true focused field as a blur', () => {
    const h = handler(() => true);
    h.rpc({}, 'c1');
    expect(isDesktopPresent(h.tracker.snapshot(), NOW)).toBe(false);
    h.rpc({ focused: 'yes' }, 'c1');
    expect(isDesktopPresent(h.tracker.snapshot(), NOW)).toBe(false);
  });
});

describe('DeferredPushQueue', () => {
  function payload(id: string): PushPayload {
    return { title: 'Approval needed', body: 'q', approvalId: id, sessionId: 's1' };
  }

  function harness(initiallyPresent = true) {
    const send = vi.fn();
    let presentNow = initiallyPresent;
    let fire: (() => void) | null = null;
    const queue = new DeferredPushQueue({
      send,
      isPresent: () => presentNow,
      staleAfterMs: () => DESKTOP_PRESENCE_STALE_AFTER_MS,
      setTimer: (fn) => {
        fire = fn;
        return 1;
      },
      clearTimer: () => {
        fire = null;
      },
    });
    return {
      queue,
      send,
      setPresent: (v: boolean) => {
        presentNow = v;
      },
      fireTimer: () => fire?.(),
      hasTimer: () => fire !== null,
    };
  }

  it('delivers a held push when presence goes away, with the same collapseId', () => {
    const h = harness();
    h.queue.park('ap-1', payload('ap-1'), 'ap-sess-1');
    expect(h.send).not.toHaveBeenCalled();

    h.setPresent(false);
    h.queue.onPresenceChanged();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(payload('ap-1'), { collapseId: 'ap-sess-1' });
    expect(h.queue.size).toBe(0);
  });

  it('keeps holding while presence persists', () => {
    const h = harness();
    h.queue.park('ap-1', payload('ap-1'));
    h.queue.onPresenceChanged();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.queue.size).toBe(1);
  });

  it('delivers on the stale-expiry timer when nobody reports a transition', () => {
    const h = harness();
    h.queue.park('ap-1', payload('ap-1'));
    // The user walked away without blurring; the window simply ages out.
    h.setPresent(false);
    h.fireTimer();
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('re-arms rather than delivering when the timer fires and presence is fresh', () => {
    const h = harness();
    h.queue.park('ap-1', payload('ap-1'));
    h.fireTimer();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.queue.size).toBe(1);
    expect(h.hasTimer()).toBe(true);
  });

  it('does not deliver a push whose approval was already resolved', () => {
    const h = harness();
    h.queue.park('ap-1', payload('ap-1'));
    h.queue.forget('ap-1');

    h.setPresent(false);
    h.queue.onPresenceChanged();
    h.fireTimer();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('drops the oldest held push past the cap', () => {
    const h = harness();
    for (let i = 0; i < DEFERRED_PUSH_CAP + 1; i++) {
      h.queue.park(`ap-${i}`, payload(`ap-${i}`));
    }
    expect(h.queue.size).toBe(DEFERRED_PUSH_CAP);

    h.setPresent(false);
    h.queue.onPresenceChanged();
    const sentIds = h.send.mock.calls.map((c) => (c[0] as PushPayload).approvalId);
    expect(sentIds).not.toContain('ap-0');
    expect(sentIds).toContain(`ap-${DEFERRED_PUSH_CAP}`);
  });

  it('drops everything on dispose without sending', () => {
    const h = harness();
    h.queue.park('ap-1', payload('ap-1'));
    h.queue.dispose();
    expect(h.queue.size).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
  });
});
