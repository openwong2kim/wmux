import { describe, it, expect, vi } from 'vitest';

import {
  DESKTOP_PRESENCE_RPC,
  attachDesktopPresenceReporter,
  reportDesktopPresence,
  type PresenceApp,
  type PresencePowerMonitor,
  type PresenceRpcClient,
} from '../desktopPresence';

function client(overrides: Partial<PresenceRpcClient> = {}): PresenceRpcClient {
  return {
    isConnected: true,
    rpc: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  } as PresenceRpcClient;
}

/** Collects `on(event, fn)` registrations so a test can fire them. */
function listenerSink(): { on: (e: string, fn: () => void) => unknown; fire: (e: string) => void } {
  const map = new Map<string, (() => void)[]>();
  return {
    on: (e, fn) => {
      map.set(e, [...(map.get(e) ?? []), fn]);
      return undefined;
    },
    fire: (e) => {
      for (const fn of map.get(e) ?? []) fn();
    },
  };
}

describe('reportDesktopPresence', () => {
  it('sends the focus bit over the presence RPC', () => {
    const c = client();
    reportDesktopPresence(() => c, true);
    expect(c.rpc).toHaveBeenCalledWith(DESKTOP_PRESENCE_RPC, { focused: true });
  });

  it('is a no-op with no client or a disconnected one', () => {
    expect(() => reportDesktopPresence(() => null, true)).not.toThrow();
    const c = client({ isConnected: false });
    reportDesktopPresence(() => c, true);
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it('swallows a rejected focus report without retrying — a lost buzz is cheap', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error('unknown method'));
    const c = client({ rpc });
    vi.useFakeTimers();
    try {
      expect(() => reportDesktopPresence(() => c, true)).not.toThrow();
      await Promise.resolve();
      vi.advanceTimersByTime(5_000);
      expect(rpc).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a failed BLUR once — a lost blur keeps notifications held', async () => {
    const rpc = vi
      .fn()
      .mockRejectedValueOnce(new Error('transport blip'))
      .mockResolvedValue({ ok: true });
    const c = client({ rpc });
    vi.useFakeTimers();
    try {
      reportDesktopPresence(() => c, false, { retryMs: 10 });
      // Let the rejected promise's catch run before the timer is scheduled.
      await vi.advanceTimersByTimeAsync(50);
      expect(rpc).toHaveBeenCalledTimes(2);
      expect(rpc).toHaveBeenLastCalledWith(DESKTOP_PRESENCE_RPC, { focused: false });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('attachDesktopPresenceReporter', () => {
  it('reports true on window focus and false on blur', () => {
    const sink = listenerSink();
    const app = { on: sink.on } as unknown as PresenceApp;
    const c = client();
    attachDesktopPresenceReporter(app, () => c);

    sink.fire('browser-window-focus');
    expect(c.rpc).toHaveBeenLastCalledWith(DESKTOP_PRESENCE_RPC, { focused: true });

    sink.fire('browser-window-blur');
    expect(c.rpc).toHaveBeenLastCalledWith(DESKTOP_PRESENCE_RPC, { focused: false });
  });

  it('reports a blur on lock-screen, suspend, and shutdown — none of which blur a window', () => {
    for (const event of ['lock-screen', 'suspend', 'shutdown']) {
      const appSink = listenerSink();
      const powerSink = listenerSink();
      const c = client();
      attachDesktopPresenceReporter(
        { on: appSink.on } as unknown as PresenceApp,
        () => c,
        {
          powerMonitor: { on: powerSink.on } as unknown as PresencePowerMonitor,
          isFocused: () => true,
        },
      );

      powerSink.fire(event);
      expect(c.rpc, event).toHaveBeenCalledWith(DESKTOP_PRESENCE_RPC, { focused: false });
    }
  });

  it('re-reports the real focus state on unlock and resume', () => {
    const appSink = listenerSink();
    const powerSink = listenerSink();
    const c = client();
    let focused = false;
    attachDesktopPresenceReporter({ on: appSink.on } as unknown as PresenceApp, () => c, {
      powerMonitor: { on: powerSink.on } as unknown as PresencePowerMonitor,
      isFocused: () => focused,
    });

    powerSink.fire('unlock-screen');
    expect(c.rpc).toHaveBeenLastCalledWith(DESKTOP_PRESENCE_RPC, { focused: false });

    focused = true;
    powerSink.fire('resume');
    expect(c.rpc).toHaveBeenLastCalledWith(DESKTOP_PRESENCE_RPC, { focused: true });
  });
});
