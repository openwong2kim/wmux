import { describe, it, expect, vi } from 'vitest';

import {
  DESKTOP_PRESENCE_RPC,
  attachDesktopPresenceReporter,
  reportDesktopPresence,
  type PresenceApp,
  type PresenceRpcClient,
} from '../desktopPresence';

function client(overrides: Partial<PresenceRpcClient> = {}): PresenceRpcClient {
  return {
    isConnected: true,
    rpc: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  } as PresenceRpcClient;
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

  it('swallows a rejected RPC — an old daemon must not surface an error here', () => {
    const c = client({ rpc: vi.fn().mockRejectedValue(new Error('unknown method')) });
    expect(() => reportDesktopPresence(() => c, false)).not.toThrow();
  });
});

describe('attachDesktopPresenceReporter', () => {
  it('reports true on window focus and false on blur', () => {
    const listeners = new Map<string, () => void>();
    const app: PresenceApp = {
      on: (event, listener) => {
        listeners.set(event, listener);
        return app;
      },
    };
    const c = client();
    attachDesktopPresenceReporter(app, () => c);

    listeners.get('browser-window-focus')?.();
    expect(c.rpc).toHaveBeenLastCalledWith(DESKTOP_PRESENCE_RPC, { focused: true });

    listeners.get('browser-window-blur')?.();
    expect(c.rpc).toHaveBeenLastCalledWith(DESKTOP_PRESENCE_RPC, { focused: false });
  });
});
