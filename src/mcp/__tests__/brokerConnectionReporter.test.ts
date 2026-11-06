import { describe, expect, it, vi } from 'vitest';
import { createConnectionReporter, type ReportChannel } from '../brokerConnectionReporter';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function channel(over: Partial<ReportChannel> = {}): ReportChannel & { send: ReturnType<typeof vi.fn> } {
  return { connected: true, send: vi.fn(), ...over } as ReportChannel & { send: ReturnType<typeof vi.fn> };
}

describe('broker connection reporter', () => {
  it('sends one exact report per burst, with the final count', async () => {
    const ch = channel();
    const r = createConnectionReporter(ch);
    r.opened();
    r.opened();
    r.opened();
    r.closed();
    await flush();
    expect(ch.send).toHaveBeenCalledTimes(1);
    expect(ch.send.mock.calls[0][0]).toEqual({ wmuxBroker: 'connections', open: 2 });
  });

  it('never reports below zero', async () => {
    const ch = channel();
    const r = createConnectionReporter(ch);
    r.closed();
    await flush();
    expect(ch.send.mock.calls[0][0]).toEqual({ wmuxBroker: 'connections', open: 0 });
  });

  it('does nothing without a channel or with a disconnected one', async () => {
    const none = createConnectionReporter({ connected: false });
    none.opened();
    const ch = channel({ connected: false });
    createConnectionReporter(ch).opened();
    await flush();
    expect(ch.send).not.toHaveBeenCalled();
  });

  it('swallows a channel that closes under it, sync or async', async () => {
    const sync = channel({
      send: vi.fn(() => {
        throw Object.assign(new Error('Channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' });
      }) as never,
    });
    createConnectionReporter(sync).opened();
    await expect(flush()).resolves.toBeUndefined();
    const asyncErr = channel();
    createConnectionReporter(asyncErr).opened();
    await flush();
    // The callback form keeps an async failure off the process 'error' event.
    const cb = asyncErr.send.mock.calls[0][1] as (err: Error | null) => void;
    expect(typeof cb).toBe('function');
    expect(() => cb(new Error('Channel closed'))).not.toThrow();
  });
});
